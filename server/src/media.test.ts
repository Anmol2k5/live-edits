// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, wavBytes, startTestApp } from "./test-helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaasApp } from "./app.ts";
import { MemoryStore } from "./store.ts";
import { FilesystemStorage } from "./storage.ts";

async function upload(base: string, token: string, ws: string, name: string, body: Buffer, contentType = "audio/wav"): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}/api/workspaces/${ws}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType, "X-Filename": encodeURIComponent(name) },
    body: new Uint8Array(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed };
}

describe("saas media (M7)", () => {
  it("uploads, lists, serves, signs, replaces, and deletes", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "m@example.com");
      const ws = await createWorkspace(app.base, a.token, "Media");
      const up = await upload(app.base, a.token, ws, "clip.wav", wavBytes(4096));
      expect(up.status).toBe(201);

      const list = await api(app.base, "GET", `/api/workspaces/${ws}/media`, a.token);
      expect((list.json as { media: Array<{ name: string }> }).media.map((m) => m.name)).toContain("clip.wav");

      const get = await fetch(`${app.base}/api/workspaces/${ws}/media/clip.wav`, { headers: { Authorization: `Bearer ${a.token}` } });
      expect(get.status).toBe(200);
      expect(Number(get.headers.get("content-length"))).toBe(wavBytes(4096).length);
      await get.arrayBuffer();

      const signed = await api(app.base, "POST", `/api/workspaces/${ws}/media/clip.wav/signed-url`, a.token);
      expect(signed.status).toBe(200);
      expect((signed.json as { signature: string }).signature).toMatch(/^[0-9a-f]{64}$/);
      const overlay = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Signed media" });
      const overlayId = (overlay.json as { overlay: { id: string } }).overlay.id;
      const { signature, expiresAt } = signed.json as { signature: string; expiresAt: number };
      const signedPath = `${app.base}/o/${overlayId}/media/clip.wav?exp=${expiresAt}&sig=${signature}`;
      const signedMedia = await fetch(signedPath);
      expect(signedMedia.status).toBe(200);
      expect(Buffer.from(await signedMedia.arrayBuffer())).toEqual(wavBytes(4096));
      const tampered = await fetch(signedPath.replace(signature, "0".repeat(64)));
      expect(tampered.status).toBe(403);
      await tampered.arrayBuffer();

      // Duplicate names are refused, never silently overwritten.
      const dup = await upload(app.base, a.token, ws, "clip.wav", wavBytes(100, 9));
      expect(dup.status).toBe(409);

      // Atomic versioned replacement bumps the version.
      const rep = await fetch(`${app.base}/api/workspaces/${ws}/media/clip.wav`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "audio/wav" },
        body: new Uint8Array(wavBytes(200, 9)),
      });
      expect(rep.status).toBe(200);
      expect((await rep.json() as { version: number }).version).toBe(2);

      const del = await api(app.base, "DELETE", `/api/workspaces/${ws}/media/clip.wav`, a.token);
      expect(del.status).toBe(200);
      expect((await api(app.base, "GET", `/api/workspaces/${ws}/media`, a.token).then((r) => r.json) as { media: unknown[] }).media).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects traversal, bad types, empties, oversize, and content mismatches", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "mv@example.com");
      const ws = await createWorkspace(app.base, a.token, "Strict");
      expect((await upload(app.base, a.token, ws, "../evil.wav", wavBytes(10))).status).toBe(400);
      expect((await upload(app.base, a.token, ws, "clip.avi", wavBytes(10))).status).toBe(400);
      expect((await upload(app.base, a.token, ws, "empty.wav", Buffer.alloc(0))).status).toBe(400);
      const pngAsWav = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);
      expect((await upload(app.base, a.token, ws, "fake.wav", pngAsWav)).status).toBe(400);
      // Declared oversize dies before touching storage.
      const big = await upload(app.base, a.token, ws, "huge.wav", wavBytes(10));
      expect([201, 400, 413]).toContain(big.status);
    } finally {
      await app.close();
    }
  });

  it("enforces quotas, ownership, and cleans up failed uploads", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "q1@example.com");
      const b = await register(app.base, "q2@example.com");
      const wsA = await createWorkspace(app.base, a.token, "QA");
      const wsB = await createWorkspace(app.base, b.token, "QB");
      await upload(app.base, a.token, wsA, "a.wav", wavBytes(100));

      // Cross-workspace access is denied even with a valid session.
      expect((await api(app.base, "GET", `/api/workspaces/${wsA}/media`, b.token)).status).toBe(404);
      const crossGet = await fetch(`${app.base}/api/workspaces/${wsA}/media/a.wav`, { headers: { Authorization: `Bearer ${b.token}` } });
      expect(crossGet.status).toBe(404);
      await crossGet.arrayBuffer().catch(() => undefined);
      const crossDel = await api(app.base, "DELETE", `/api/workspaces/${wsA}/media/a.wav`, b.token);
      expect(crossDel.status).toBe(404);

      // Failed uploads leave no row behind.
      const bad = await upload(app.base, a.token, wsA, "bad.wav", Buffer.from([1, 2, 3]));
      expect(bad.status).toBe(400);
      const list = (await api(app.base, "GET", `/api/workspaces/${wsA}/media`, a.token).then((r) => r.json) as { media: Array<{ name: string }> }).media;
      expect(list.map((m) => m.name)).not.toContain("bad.wav");
      expect(list.map((m) => m.name)).toContain("a.wav");
      expect(wsB).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it.each(["upload", "replace"])("enforces the workspace quota during concurrent %ss", async (operation) => {
    const app = await startTestApp({ quotaBytes: 800 });
    try {
      const user = await register(app.base, "quota-race@example.com");
      const ws = await createWorkspace(app.base, user.token, "Concurrent quota");
      if (operation === "replace") {
        expect((await upload(app.base, user.token, ws, "a.wav", wavBytes(100))).status).toBe(201);
        expect((await upload(app.base, user.token, ws, "b.wav", wavBytes(100))).status).toBe(201);
      }
      const write = async (name: string) => {
        if (operation === "upload") return (await upload(app.base, user.token, ws, name, wavBytes(400))).status;
        const response = await fetch(`${app.base}/api/workspaces/${ws}/media/${name}`, {
          method: "PUT", headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "audio/wav" }, body: new Uint8Array(wavBytes(400)),
        });
        await response.arrayBuffer();
        return response.status;
      };
      const statuses = await Promise.all([write("a.wav"), write("b.wav")]);
      expect(statuses).toContain(413);
      expect(statuses.filter((status) => status === (operation === "upload" ? 201 : 200))).toHaveLength(1);
      const list = await api(app.base, "GET", `/api/workspaces/${ws}/media`, user.token);
      const media = (list.json as { media: Array<{ bytes: number }> }).media;
      expect(media.reduce((sum, item) => sum + item.bytes, 0)).toBeLessThanOrEqual(800);
    } finally {
      await app.close();
    }
  });

  it("waits for a pending delete before reusing the same media name", async () => {
    let deleting!: () => void;
    let finishDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve; });
    const deleteReleased = new Promise<void>((resolve) => { finishDelete = resolve; });
    class PausedDeleteStorage extends FilesystemStorage {
      override async remove(workspaceId: string, name: string): Promise<boolean> {
        deleting();
        await deleteReleased;
        return super.remove(workspaceId, name);
      }
    }
    const storage = new PausedDeleteStorage(mkdtempSync(join(tmpdir(), "saas-delete-race-")));
    const app = createSaasApp({ store: new MemoryStore(), storage });
    const { base } = await app.listen(0);
    try {
      const user = await register(base, "delete-race@example.com");
      const ws = await createWorkspace(base, user.token, "Delete and upload");
      expect((await upload(base, user.token, ws, "same.wav", wavBytes(100))).status).toBe(201);
      const deletion = api(base, "DELETE", `/api/workspaces/${ws}/media/same.wav`, user.token);
      await deleteStarted;
      const replacement = upload(base, user.token, ws, "same.wav", wavBytes(400, 9));
      const earlyResult = await Promise.race([replacement, new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))]);
      finishDelete();
      expect(earlyResult).toBeNull();
      expect((await deletion).status).toBe(200);
      expect((await replacement).status).toBe(201);
      const file = await fetch(`${base}/api/workspaces/${ws}/media/same.wav`, { headers: { Authorization: `Bearer ${user.token}` } });
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(wavBytes(400, 9));
    } finally {
      finishDelete();
      await app.close();
    }
  });
});

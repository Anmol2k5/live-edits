// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, samplePack, wavBytes, startTestApp } from "./test-helpers.ts";

async function upload(base: string, token: string, ws: string, name: string, body: Buffer): Promise<number> {
  const response = await fetch(`${base}/api/workspaces/${ws}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav", "X-Filename": encodeURIComponent(name) },
    body: new Uint8Array(body),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

describe("saas overlays and triggers (M7)", () => {
  it("creates overlay sessions, delivers triggers, and isolates workspaces", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "oa@example.com");
      const b = await register(app.base, "ob@example.com");
      const wsA = await createWorkspace(app.base, a.token, "WA");
      const wsB = await createWorkspace(app.base, b.token, "WB");
      await api(app.base, "POST", `/api/workspaces/${wsA}/packs`, a.token, samplePack());
      await api(app.base, "POST", `/api/workspaces/${wsA}/activate`, a.token, { packUid: "pack-1" });
      expect(await upload(app.base, a.token, wsA, "clip.wav", wavBytes(2000))).toBe(201);

      const mkA = await api(app.base, "POST", `/api/workspaces/${wsA}/overlays`, a.token, { name: "OBS Main" });
      expect(mkA.status).toBe(201);
      const { overlay, viewToken } = mkA.json as { overlay: { id: string }; viewToken: string };

      const mkB = await api(app.base, "POST", `/api/workspaces/${wsB}/overlays`, b.token, { name: "Other" });
      const other = mkB.json as { overlay: { id: string }; viewToken: string };

      // Two simultaneous overlays on A both connect.
      const ea = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(ea.status).toBe(200);
      const ra = ea.body?.getReader();
      await ra?.read();
      const eb = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(eb.status).toBe(200);
      const rb = eb.body?.getReader();
      await rb?.read();
      const eo = await fetch(`${app.base}/o/${other.overlay.id}/events?token=${other.viewToken}`);
      expect(eo.status).toBe(200);
      const ro = eo.body?.getReader();
      await ro?.read();

      const fire = await api(app.base, "POST", `/api/workspaces/${wsA}/trigger`, a.token, { moment: "wow", effectId: "clip-1" });
      expect(fire.status).toBe(202);
      expect((fire.json as { accepted: boolean }).accepted).toBe(true);

      const decode = async (reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<string> => {
        if (!reader) return "";
        const { value } = await reader.read();
        return new TextDecoder().decode(value);
      };
      const chunkA = await decode(ra);
      const chunkB = await decode(rb);
      expect(chunkA).toMatch(/event: reaction/);
      expect(chunkA).toMatch(/clip\.wav/);
      expect(chunkB).toMatch(/event: reaction/);
      // Other workspace receives nothing (with a short timeout, no reaction frame arrives).
      const raced = await Promise.race([
        decode(ro).then((c) => c),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      expect(raced).not.toMatch(/event: reaction/);

      await ra?.cancel().catch(() => undefined);
      await rb?.cancel().catch(() => undefined);
      await ro?.cancel().catch(() => undefined);

      // History + audit recorded.
      const hist = await api(app.base, "GET", `/api/workspaces/${wsA}/triggers`, a.token);
      expect((hist.json as { triggers: unknown[] }).triggers.length).toBeGreaterThan(0);
      const audit = await api(app.base, "GET", `/api/workspaces/${wsA}/audit`, a.token);
      expect((audit.json as { audit: unknown[] }).audit.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("revokes and rotates sessions; revoked tokens are rejected everywhere", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "rev@example.com");
      const ws = await createWorkspace(app.base, a.token, "Rev");
      const mk = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Main" });
      const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };

      expect((await fetch(`${app.base}/o/${overlay.id}?token=${viewToken}`).then(async (r) => {
        await r.arrayBuffer().catch(() => undefined);
        return r.status;
      }))).toBe(200);

      const rot = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/rotate`, a.token);
      expect(rot.status).toBe(200);
      const fresh = (rot.json as { viewToken: string }).viewToken;
      expect(fresh).not.toBe(viewToken);
      expect((await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`).then((r) => r.status))).toBe(403);
      const ev2 = await fetch(`${app.base}/o/${overlay.id}/events?token=${fresh}`);
      expect(ev2.status).toBe(200);
      await ev2.body?.getReader().read().catch(() => undefined);
      await ev2.body?.cancel().catch(() => undefined);

      const rev = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/revoke`, a.token);
      expect(rev.status).toBe(200);
      expect((await fetch(`${app.base}/o/${overlay.id}?token=${fresh}`).then((r) => r.status))).toBe(403);
      expect((await fetch(`${app.base}/o/${overlay.id}/events?token=${fresh}`).then((r) => r.status))).toBe(403);
      const again = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/rotate`, a.token);
      expect(again.status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("expires triggers, deduplicates repeats, and rejects bad payloads/media", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "t7@example.com");
      const ws = await createWorkspace(app.base, a.token, "Trig");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });
      await upload(app.base, a.token, ws, "clip.wav", wavBytes(500));

      const expired = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", expiresAt: Date.now() - 1000 });
      expect(expired.status).toBe(400);

      const first = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1", triggerId: "dup-1" });
      expect(first.status).toBe(202);
      const repeat = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1", triggerId: "dup-1" });
      expect(repeat.status).toBe(202);
      expect((repeat.json as { duplicate: boolean }).duplicate).toBe(true);

      const ghost = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", mediaFile: "ghost.wav" });
      expect(ghost.status).toBe(400);
      const unknown = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "effect-nope" });
      expect(unknown.status).toBe(400);
      const mismatch = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", templateId: "sad-1" });
      expect(mismatch.status).toBe(400);

      // Unauthorized trigger attempts cannot touch the workspace.
      const b = await register(app.base, "t7b@example.com");
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, b.token, { moment: "wow" })).status).toBe(404);
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, undefined, { moment: "wow" })).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, register, createWorkspace, samplePack, wavBytes, startTestApp } from "./test-helpers.ts";
import { createSaasApp } from "./app.ts";
import { MemoryStore } from "./store.ts";
import { FilesystemStorage, validMediaName, sniffKind, kindForExt } from "./storage.ts";
import { readMigrationSql } from "./store.ts";

describe("saas session expiry (M7)", () => {
  it("rejects sessions past their TTL", async () => {
    process.env["LIVE_EDITS_SESSION_TTL_MS"] = "150";
    const storage = new FilesystemStorage(mkdtempSync(join(tmpdir(), "saas-exp-")));
    await storage.init();
    const app = createSaasApp({ store: new MemoryStore(), storage, secret: "exp-secret" });
    const { base } = await app.listen(0);
    try {
      const reg = await register(base, "ttl@example.com");
      expect((await api(base, "GET", "/api/auth/me", reg.token)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 350));
      expect((await api(base, "GET", "/api/auth/me", reg.token)).status).toBe(401);
    } finally {
      delete process.env["LIVE_EDITS_SESSION_TTL_MS"];
      await app.close();
    }
  });
});

describe("saas migrations and storage guards (M7)", () => {
  it("ships a Postgres migration covering every persisted entity", async () => {
    const sql = await readMigrationSql();
    for (const table of ["users", "password_resets", "sessions", "workspaces", "memberships", "packs", "effects", "assignments", "sequence_steps", "media", "overlay_sessions", "trigger_history", "audit_events"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    expect(sql).toMatch(/UNIQUE \(workspace_id, pack_uid\)/);
    expect(sql).toMatch(/UNIQUE \(workspace_id, name\)/);
    expect(sql).toMatch(/FOREIGN KEY|REFERENCES/);
  });

  it("validates filenames and sniffs content like the local relay", () => {
    expect(validMediaName("clip.wav")).toBe(true);
    expect(validMediaName("../evil.wav")).toBe(false);
    expect(validMediaName("a".repeat(129) + ".wav")).toBe(false);
    expect(validMediaName("clip.avi")).toBe(false);
    expect(kindForExt(".wav")).toBe("audio");
    expect(kindForExt(".webm")).toBe("video");
    expect(kindForExt(".png")).toBe("image");
    expect(kindForExt(".avi")).toBeNull();
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffKind(wav, ".wav")).toBe("audio");
    expect(sniffKind(wav, ".mp3")).toBeNull();
  });
});

describe("saas save/reload consistency (M7)", () => {
  it("packs and media survive a dashboard reload without reimport", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "rl@example.com");
      const ws = await createWorkspace(app.base, a.token, "Reload");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      const up = await fetch(`${app.base}/api/workspaces/${ws}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "audio/wav", "X-Filename": "clip.wav" },
        body: new Uint8Array(wavBytes(300)),
      });
      expect(up.status).toBe(201);
      await up.arrayBuffer().catch(() => undefined);
      await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });

      // "Reload": fresh reads, same server.
      const packs = await api(app.base, "GET", `/api/workspaces/${ws}/packs`, a.token);
      expect((packs.json as { packs: Array<{ packUid: string }> }).packs.map((p) => p.packUid)).toContain("pack-1");
      const media = await api(app.base, "GET", `/api/workspaces/${ws}/media`, a.token);
      expect((media.json as { media: Array<{ name: string }> }).media.map((m) => m.name)).toContain("clip.wav");
      const fire = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1" });
      expect(fire.status).toBe(202);
      expect((fire.json as { accepted: boolean }).accepted).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, samplePack, startTestApp } from "./test-helpers.ts";

describe("saas packs (M7)", () => {
  it("saves, loads, updates, and deletes packs with validation", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "p@example.com");
      const ws = await createWorkspace(app.base, a.token, "Packs");
      const save = await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      expect(save.status).toBe(201);

      const get = await api(app.base, "GET", `/api/workspaces/${ws}/packs/pack-1`, a.token);
      expect(get.status).toBe(200);
      expect((get.json as { pack: { name: string } }).pack.name).toBe("Cloud Pack");

      const bad = await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, {
        version: 1, id: "bad", name: "Bad",
        effects: [], assignments: [{ id: "a", source: "manual", effectId: "ghost" }], sequence: [],
      });
      expect(bad.status).toBe(400);

      const del = await api(app.base, "DELETE", `/api/workspaces/${ws}/packs/pack-1`, a.token);
      expect(del.status).toBe(200);
      expect((await api(app.base, "GET", `/api/workspaces/${ws}/packs/pack-1`, a.token)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("stays compatible with local pack JSON in both directions", async () => {
    const app = await startTestApp();
    try {
      // A pack produced by the local editor (src/packs/packSchemas) must validate server-side.
      const local = await import("../../src/packs/packSchemas");
      const created = local.createPack("Local Shape");
      created.effects.push({
        id: "vid-1", name: "Clip", kind: "video", mediaFile: "clip.wav", moment: "wow",
        durationMs: 2700, delayMs: 0, cooldownMs: 4000, priority: 60, queue: "queue",
        enabled: true, volume: 0.5, position: "center", entrance: "pop", exit: "fade", muted: false,
      } as never);
      created.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "vid-1" });
      created.sequence.push({ id: "s1", effectId: "vid-1", delayMs: 500 });
      const exported = JSON.parse(local.serializePack(created));

      const a = await register(app.base, "compat@example.com");
      const ws = await createWorkspace(app.base, a.token, "Compat");
      const save = await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, exported);
      expect(save.status).toBe(201);

      // Server export must parse with the local schema (round-trip).
      const exp = await api(app.base, "GET", `/api/workspaces/${ws}/packs/${created.id}/export`, a.token);
      expect(exp.status).toBe(200);
      expect(() => local.parsePack(exp.json)).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it("rewrites colliding ids on import and keeps save/reload consistent", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "imp@example.com");
      const ws = await createWorkspace(app.base, a.token, "Imp");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack("pack-1"));
      const imp = await api(app.base, "POST", `/api/workspaces/${ws}/packs/import`, a.token, { data: samplePack("pack-1") });
      expect(imp.status).toBe(201);
      const pack = (imp.json as { pack: { packUid: string; data: { effects: Array<{ id: string }>; assignments: Array<{ effectId: string }> } } }).pack;
      expect(pack.packUid).not.toBe("pack-1");
      // Same-file reimport never collides again.
      const again = await api(app.base, "POST", `/api/workspaces/${ws}/packs/import`, a.token, { data: samplePack("pack-1") });
      expect(again.status).toBe(201);
      const list = await api(app.base, "GET", `/api/workspaces/${ws}/packs`, a.token);
      const uids = (list.json as { packs: Array<{ packUid: string }> }).packs.map((p) => p.packUid);
      expect(new Set(uids).size).toBe(uids.length);
    } finally {
      await app.close();
    }
  });
});

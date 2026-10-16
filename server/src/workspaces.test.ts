// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, startTestApp } from "./test-helpers.ts";

describe("saas workspaces and membership (M7)", () => {
  it("creates workspaces owned by the creator and lists them", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "a@example.com");
      const id = await createWorkspace(app.base, a.token, "Stream Team");
      const list = await api(app.base, "GET", "/api/workspaces", a.token);
      expect(list.status).toBe(200);
      const items = (list.json as { workspaces: Array<{ id: string; role: string }> }).workspaces;
      expect(items.map((w) => w.id)).toContain(id);
      expect(items.find((w) => w.id === id)?.role).toBe("owner");
    } finally {
      await app.close();
    }
  });

  it("isolates tenants: outsiders get 404 and cannot trigger", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "a2@example.com");
      const b = await register(app.base, "b2@example.com");
      const ws = await createWorkspace(app.base, a.token, "Private");

      expect((await api(app.base, "GET", `/api/workspaces/${ws}`, b.token)).status).toBe(404);
      expect((await api(app.base, "GET", `/api/workspaces/${ws}/packs`, b.token)).status).toBe(404);
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, b.token, { moment: "wow" })).status).toBe(404);
      expect((await api(app.base, "GET", `/api/workspaces/${ws}/media`, b.token)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("manages membership by owner role only and protects the last owner", async () => {
    const app = await startTestApp();
    try {
      const owner = await register(app.base, "owner@example.com");
      const mate = await register(app.base, "mate@example.com");
      const ws = await createWorkspace(app.base, owner.token, "Crew");

      const add = await api(app.base, "POST", `/api/workspaces/${ws}/members`, owner.token, { email: "mate@example.com", role: "member" });
      expect(add.status).toBe(201);

      const mateAdds = await api(app.base, "POST", `/api/workspaces/${ws}/members`, mate.token, { email: "owner@example.com", role: "member" });
      expect(mateAdds.status).toBe(403);

      const members = await api(app.base, "GET", `/api/workspaces/${ws}/members`, mate.token);
      expect(members.status).toBe(200);
      expect((members.json as { members: unknown[] }).members).toHaveLength(2);

      const selfRemoveOwner = await api(app.base, "DELETE", `/api/workspaces/${ws}/members/${owner.userId}`, owner.token);
      expect(selfRemoveOwner.status).toBe(409);

      const remove = await api(app.base, "DELETE", `/api/workspaces/${ws}/members/${mate.userId}`, owner.token);
      expect(remove.status).toBe(200);
      expect((await api(app.base, "GET", `/api/workspaces/${ws}`, mate.token)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("activates packs and rejects unknown pack ids", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "act@example.com");
      const ws = await createWorkspace(app.base, a.token, "Acts");
      const save = await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, {
        version: 1, id: "pack-1", name: "P", effects: [], assignments: [], sequence: [],
      });
      expect(save.status).toBe(201);
      const act = await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });
      expect(act.status).toBe(200);
      const ghost = await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "nope" });
      expect(ghost.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

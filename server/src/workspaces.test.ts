// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, startTestApp } from "./test-helpers.ts";
import { MemoryStore } from "./store.ts";
import { randomUUID } from "node:crypto";

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

  it("returns 404 for nonexistent workspace UUIDs without invalid audit references", async () => {
    const app = await startTestApp();
    // Match PostgreSQL's audit FK constraint when running without a database.
    const recordAudit = app.store.recordAudit.bind(app.store);
    if (app.store instanceof MemoryStore) {
      app.store.recordAudit = async (row) => {
        if (row.workspaceId !== null && !(await app.store.findWorkspace(row.workspaceId))) {
          throw Object.assign(new Error("audit workspace foreign key constraint"), { code: "23503" });
        }
        return recordAudit(row);
      };
    }
    try {
      const user = await register(app.base, "missing-workspace@example.com");
      const missing = randomUUID();
      const result = await api(app.base, "GET", `/api/workspaces/${missing}`, user.token);
      expect(result.status).toBe(404);
      expect(result.json).toEqual({ error: "not found" });
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

  it.each(["admin", "member"])("refuses to demote the last owner to %s", async (role) => {
    const app = await startTestApp();
    try {
      const owner = await register(app.base, "last@example.com");
      const ws = await createWorkspace(app.base, owner.token, "Keep owner");
      const demote = await api(app.base, "POST", `/api/workspaces/${ws}/members`, owner.token, { email: "last@example.com", role });
      expect(demote.status).toBe(409);
      const members = await api(app.base, "GET", `/api/workspaces/${ws}/members`, owner.token);
      expect((members.json as { members: Array<{ role: string }> }).members.map((m) => m.role)).toEqual(["owner"]);
    } finally {
      await app.close();
    }
  });

  it.each(["demote", "remove", "mixed"])("retains an owner during concurrent membership reductions (%s)", async (operation) => {
    const app = await startTestApp();
    try {
      const first = await register(app.base, "first@example.com");
      const second = await register(app.base, "second@example.com");
      const ws = await createWorkspace(app.base, first.token, "Concurrent owners");
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/members`, first.token, { email: "second@example.com", role: "owner" })).status).toBe(201);
      const reduce = (owner: typeof first, email: string, remove: boolean) => remove
        ? api(app.base, "DELETE", `/api/workspaces/${ws}/members/${owner.userId}`, owner.token)
        : api(app.base, "POST", `/api/workspaces/${ws}/members`, owner.token, { email, role: "admin" });
      const results = await Promise.all([
        reduce(first, "first@example.com", operation === "remove"),
        reduce(second, "second@example.com", operation !== "demote"),
      ]);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      const survivor = results[0].status === 409 ? first : second;
      const members = await api(app.base, "GET", `/api/workspaces/${ws}/members`, survivor.token);
      expect((members.json as { members: Array<{ role: string }> }).members.filter((m) => m.role === "owner")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

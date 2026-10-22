// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaasApp } from "./app.ts";
import { PostgresStore } from "./store.ts";
import { S3Storage } from "./storage.ts";
import { InMemoryEmailProvider } from "./email.ts";

const ENABLED = process.env["SAAS_REAL_SERVICES"] === "1";

function dsn(): string {
  return process.env["SAAS_TEST_DSN"] || "postgres://postgres@127.0.0.1:5433/postgres";
}
function s3Endpoint(): string {
  return process.env["SAAS_TEST_S3_ENDPOINT"] || "http://127.0.0.1:5001";
}

function wavBytes(payloadSize: number, fill = 7): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + payloadSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(payloadSize, 40);
  return Buffer.concat([header, Buffer.alloc(payloadSize, fill)]);
}

describe.runIf(ENABLED)("saas real services: postgres + s3 vertical flow (M7.1)", () => {
  const SECRET = "real-services-secret-0123456789abcdef";
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.replace(/[^a-z0-9]/g, "");
  const dbName = `saas_real_${stamp}`;
  const bucket = `real-${stamp}`.toLowerCase();
  let pg: PostgresStore | null = null;
  let app: ReturnType<typeof createSaasApp> | null = null;
  let base = "";
  let storage: S3Storage | null = null;

  async function api(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, json: parsed };
  }

  beforeAll(async () => {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: dsn() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }
    pg = await PostgresStore.connect(`${dsn().replace(/\/[^/]*$/, "")}/${dbName}`);
    storage = new S3Storage(
      {
        endpoint: s3Endpoint(), region: "us-east-1", bucket,
        accessKeyId: process.env["SAAS_TEST_S3_KEY"] || "test",
        secretAccessKey: process.env["SAAS_TEST_S3_SECRET"] || "test",
        forcePathStyle: true,
      },
      mkdtempSync(join(tmpdir(), "saas-real-spool-"))
    );
    await storage.init();
    app = createSaasApp({ store: pg, storage, secret: SECRET, email: new InMemoryEmailProvider() });
    base = (await app.listen(0)).base;
  }, 120000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await pg?.close().catch(() => undefined);
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: dsn() });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }
  }, 60000);

  it("registers, logs in, and races duplicate registrations on Postgres constraints", async () => {
    const email = `race-${stamp}@example.com`;
    const [r1, r2] = await Promise.all([
      api("POST", "/api/auth/register", undefined, { email, password: "correct-horse-99" }),
      api("POST", "/api/auth/register", undefined, { email, password: "correct-horse-99" }),
    ]);
    expect(new Set([r1.status, r2.status])).toEqual(new Set([201, 409]));
  });

  it("runs the full hosted flow on real Postgres + S3 with isolation, rotate, revoke, and restart persistence", async () => {
    // Register → login.
    const regA = await api("POST", "/api/auth/register", undefined, { email: "real-a@example.com", password: "correct-horse-99" });
    expect(regA.status).toBe(201);
    const tokenA = (regA.json as { token: string }).token;
    const login = await api("POST", "/api/auth/login", undefined, { email: "real-a@example.com", password: "correct-horse-99" });
    expect(login.status).toBe(200);

    // Workspace → media into object storage → pack into PostgreSQL → activate.
    const ws = await api("POST", "/api/workspaces", tokenA, { name: "Real Team" });
    expect(ws.status).toBe(201);
    const wsId = (ws.json as { workspace: { id: string } }).workspace.id;

    const payload = wavBytes(4096);
    const up = await fetch(`${base}/api/workspaces/${wsId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "audio/wav", "X-Filename": "clip.wav" },
      body: new Uint8Array(payload),
    });
    expect(up.status).toBe(201);
    await up.arrayBuffer();

    // Concurrent duplicate upload race on a fresh name: exactly one wins.
    const raceBody = wavBytes(100, 9);
    const race = (): Promise<number> =>
      fetch(`${base}/api/workspaces/${wsId}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "audio/wav", "X-Filename": "race.wav" },
        body: new Uint8Array(raceBody),
      }).then(async (r) => {
        await r.arrayBuffer().catch(() => undefined);
        return r.status;
      });
    const [u1, u2] = await Promise.all([race(), race()]);
    expect(new Set([u1, u2])).toEqual(new Set([201, 409]));

    const pack = {
      version: 1,
      id: "real-pack-1",
      name: "Real Pack",
      effects: [
        {
          id: "clip-1", name: "Clip", kind: "video", mediaFile: "clip.wav", moment: "wow",
          durationMs: 3200, delayMs: 0, cooldownMs: 1000, priority: 70, queue: "queue",
          enabled: true, volume: 0.4, position: "fullscreen", entrance: "pop", exit: "fade", muted: false,
          clipStartMs: 200, clipEndMs: 2200,
        },
      ],
      assignments: [{ id: "a1", source: "manual", moment: "wow", effectId: "clip-1" }],
      sequence: [{ id: "s1", effectId: "clip-1", delayMs: 0 }],
    };
    expect((await api("POST", `/api/workspaces/${wsId}/packs`, tokenA, pack)).status).toBe(201);
    expect((await api("POST", `/api/workspaces/${wsId}/activate`, tokenA, { packUid: "real-pack-1" })).status).toBe(200);

    // Overlay → SSE connect → trigger assigned effect → correct media event.
    const mk = await api("POST", `/api/workspaces/${wsId}/overlays`, tokenA, { name: "OBS" });
    expect(mk.status).toBe(201);
    const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };
    const events = await fetch(`${base}/o/${overlay.id}/events?token=${viewToken}`);
    expect(events.status).toBe(200);
    const reader = events.body?.getReader();
    await reader?.read();

    const fire = await api("POST", `/api/workspaces/${wsId}/trigger`, tokenA, { moment: "wow", templateId: "wow-1" });
    expect(fire.status).toBe(202);
    let text = "";
    const deadline = Date.now() + 15000;
    while (!/event: reaction/.test(text) && Date.now() < deadline) {
      const { value } = (await reader?.read()) as { value?: Uint8Array };
      text += new TextDecoder().decode(value);
    }
    expect(text).toMatch(/"mediaFile":"clip\.wav"/);
    expect(text).toMatch(/"durationMs":3200/);

    // Served media bytes are byte-identical to the S3 upload.
    const media = await fetch(`${base}/o/${overlay.id}/media/clip.wav?token=${viewToken}`);
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).equals(payload)).toBe(true);

    // Reconnect resyncs and plays again.
    await reader?.cancel().catch(() => undefined);
    const events2 = await fetch(`${base}/o/${overlay.id}/events?token=${viewToken}`);
    expect(events2.status).toBe(200);
    const reader2 = events2.body?.getReader();
    await reader2?.read();
    const fire2 = await api("POST", `/api/workspaces/${wsId}/trigger`, tokenA, { moment: "wow", effectId: "clip-1", triggerId: "re-1" });
    expect(fire2.status).toBe(202);
    let text2 = "";
    const deadline2 = Date.now() + 15000;
    while (!/event: reaction/.test(text2) && Date.now() < deadline2) {
      const { value } = (await reader2?.read()) as { value?: Uint8Array };
      text2 += new TextDecoder().decode(value);
    }
    expect(text2).toMatch(/event: reaction/);
    await reader2?.cancel().catch(() => undefined);

    // Second workspace: fully isolated throughout.
    const regB = await api("POST", "/api/auth/register", undefined, { email: "real-b@example.com", password: "correct-horse-99" });
    const tokenB = (regB.json as { token: string }).token;
    const wsB = (await api("POST", "/api/workspaces", tokenB, { name: "Rival" }).then((r) => r.json) as { workspace: { id: string } }).workspace.id;
    expect((await api("GET", `/api/workspaces/${wsId}/packs`, tokenB)).status).toBe(404);
    expect((await api("POST", `/api/workspaces/${wsId}/trigger`, tokenB, { moment: "wow" })).status).toBe(404);

    // Rotate: old token dies, new token works.
    const rot = await api("POST", `/api/workspaces/${wsId}/overlays/${overlay.id}/rotate`, tokenA);
    expect(rot.status).toBe(200);
    const fresh = (rot.json as { viewToken: string }).viewToken;
    expect((await fetch(`${base}/o/${overlay.id}/events?token=${viewToken}`).then((r) => r.status))).toBe(403);
    const events3 = await fetch(`${base}/o/${overlay.id}/events?token=${fresh}`);
    expect(events3.status).toBe(200);
    await events3.body?.cancel().catch(() => undefined);

    // Revoke: everything for the session is forbidden afterwards.
    expect((await api("POST", `/api/workspaces/${wsId}/overlays/${overlay.id}/revoke`, tokenA)).status).toBe(200);
    expect((await fetch(`${base}/o/${overlay.id}?token=${fresh}`).then((r) => r.status))).toBe(403);
    expect((await fetch(`${base}/o/${overlay.id}/events?token=${fresh}`).then((r) => r.status))).toBe(403);

    // Restart the backend on the SAME database + bucket: records and media persist.
    await app?.close();
    const pg2 = await PostgresStore.connect(`${dsn().replace(/\/[^/]*$/, "")}/${dbName}`);
    const storage2 = new S3Storage(
      {
        endpoint: s3Endpoint(), region: "us-east-1", bucket,
        accessKeyId: process.env["SAAS_TEST_S3_KEY"] || "test",
        secretAccessKey: process.env["SAAS_TEST_S3_SECRET"] || "test",
        forcePathStyle: true,
      },
      mkdtempSync(join(tmpdir(), "saas-real-spool2-"))
    );
    const app2 = createSaasApp({ store: pg2, storage: storage2, secret: SECRET, email: new InMemoryEmailProvider() });
    const base2 = (await app2.listen(0)).base;
    try {
      // Pre-restart session still valid (persisted sessions).
      expect((await fetch(`${base2}/api/auth/me`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.status))).toBe(200);
      const packs = (await (await fetch(`${base2}/api/workspaces/${wsId}/packs`, { headers: { Authorization: `Bearer ${tokenA}` } })).json()) as {
        packs: Array<{ packUid: string }>;
      };
      expect(packs.packs.map((p) => p.packUid)).toContain("real-pack-1");
      const mediaList = (await (await fetch(`${base2}/api/workspaces/${wsId}/media`, { headers: { Authorization: `Bearer ${tokenA}` } })).json()) as {
        media: Array<{ name: string; bytes: number }>;
      };
      expect(mediaList.media.map((m) => m.name)).toContain("clip.wav");
      const hist = (await (await fetch(`${base2}/api/workspaces/${wsId}/triggers?limit=50`, { headers: { Authorization: `Bearer ${tokenA}` } })).json()) as {
        triggers: unknown[];
      };
      expect(hist.triggers.length).toBeGreaterThan(0);
      const again = await (await fetch(`${base2}/api/workspaces/${wsId}/trigger`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ moment: "wow", effectId: "clip-1", triggerId: "after-restart" }),
      })).json() as { accepted: boolean };
      expect(again.accepted).toBe(true);
      expect(wsB).toBeTruthy();
    } finally {
      await app2.close();
      await pg2.close();
    }
  }, 180000);
});

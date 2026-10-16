// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaasApp } from "./app.ts";
import { MemoryStore, PostgresStore, type Store } from "./store.ts";
import { FilesystemStorage, S3Storage, type MediaStorage } from "./storage.ts";
import { InMemoryEmailProvider } from "./email.ts";

export interface TestApp {
  base: string;
  close: () => Promise<void>;
}

function testDsn(): string {
  return process.env["SAAS_TEST_DSN"] || "postgres://postgres@127.0.0.1:5433/postgres";
}

async function testStore(): Promise<{ store: Store; cleanup: () => Promise<void> }> {
  if ((process.env["SAAS_TEST_BACKEND"] ?? "memory") !== "postgres") {
    return { store: new MemoryStore(), cleanup: async () => undefined };
  }
  // Fresh isolated database per app instance (real PostgreSQL). Retries ride
  // out transient recovery windows on constrained hosts.
  const { Client } = await import("pg");
  const dbName = `saas_t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.replace(/[^a-z0-9_]/g, "_");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const admin = new Client({ connectionString: testDsn() });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }
      const store = await PostgresStore.connect(`${testDsn().replace(/\/[^/]*$/, "")}/${dbName}`);
      return {
        store,
        cleanup: async () => {
          await store.close();
          const killer = new Client({ connectionString: testDsn() });
          await killer.connect();
          try {
            await killer.query(`DROP DATABASE "${dbName}"`);
          } finally {
            await killer.end();
          }
        },
      };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

async function testStorage(): Promise<{ storage: MediaStorage; cleanup: () => Promise<void> }> {
  if ((process.env["SAAS_TEST_S3"] ?? "") !== "1") {
    const storage = new FilesystemStorage(mkdtempSync(join(tmpdir(), "saas-media-")));
    await storage.init();
    return { storage, cleanup: async () => undefined };
  }
  // Real S3-compatible service (MinIO/moto_server); bucket per instance.
  const endpoint = process.env["SAAS_TEST_S3_ENDPOINT"] || "http://127.0.0.1:5001";
  const bucket = `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const storage = new S3Storage(
    {
      endpoint,
      region: "us-east-1",
      bucket,
      accessKeyId: process.env["SAAS_TEST_S3_KEY"] || "test",
      secretAccessKey: process.env["SAAS_TEST_S3_SECRET"] || "test",
      forcePathStyle: true,
    },
    mkdtempSync(join(tmpdir(), "saas-spool-"))
  );
  await storage.init();
  return { storage, cleanup: async () => undefined };
}

export async function startTestApp(opts: { email?: InMemoryEmailProvider } = {}): Promise<TestApp & { secret: string; email: InMemoryEmailProvider }> {
  const { store, cleanup: dropStore } = await testStore();
  const { storage } = await testStorage();
  const email = opts.email ?? new InMemoryEmailProvider();
  const app = createSaasApp({ store, storage, secret: "test-secret-0123456789abcdef", email });
  const { base } = await app.listen(0);
  return {
    base,
    secret: app.secret,
    email,
    close: async () => {
      await app.close();
      await dropStore();
    },
  };
}

export async function api(base: string, method: string, path: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
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

export async function register(base: string, email: string, password = "correct-horse-99"): Promise<{ userId: string; token: string }> {
  const res = await api(base, "POST", "/api/auth/register", undefined, { email, password, displayName: email.split("@")[0] });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  const j = res.json as { user: { id: string }; token: string };
  return { userId: j.user.id, token: j.token };
}

export async function createWorkspace(base: string, token: string, name: string): Promise<string> {
  const res = await api(base, "POST", "/api/workspaces", token, { name });
  if (res.status !== 201) throw new Error(`workspace failed: ${res.status} ${JSON.stringify(res.json)}`);
  return (res.json as { workspace: { id: string } }).workspace.id;
}

export function wavBytes(payloadSize: number, fill = 7): Buffer {
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

export function samplePack(packUid = "pack-1"): Record<string, unknown> {
  return {
    version: 1,
    id: packUid,
    name: "Cloud Pack",
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
}

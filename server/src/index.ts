import { resolve } from "node:path";
import { MemoryStore, PostgresStore } from "./store.ts";
import { FilesystemStorage } from "./storage.ts";
import { createSaasApp } from "./app.ts";

const port = Number(process.env["LIVE_EDITS_SAAS_PORT"] || process.env["PORT"] || 4290);
const host = process.env["LIVE_EDITS_SAAS_HOST"] || "127.0.0.1";
const databaseUrl = (process.env["DATABASE_URL"] || "").trim();
const storageDir = process.env["LIVE_EDITS_STORAGE_DIR"] || resolve(process.cwd(), "data", "saas-media");
const secret = (process.env["LIVE_EDITS_SESSION_SECRET"] || "").trim() || undefined;
const origins = (process.env["LIVE_EDITS_CORS_ORIGINS"] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const store = databaseUrl ? await PostgresStore.connect(databaseUrl) : new MemoryStore();
const storage = new FilesystemStorage(storageDir);
await storage.init();

const app = createSaasApp({
  store,
  storage,
  ...(secret ? { secret } : {}),
  ...(origins.length > 0 ? { corsOrigins: origins } : {}),
  storageDir,
});
const { base } = await app.listen(Number.isFinite(port) ? port : 4290, host);
console.log(`Live Edits SaaS backend at ${base} (${databaseUrl ? "postgres" : "memory store; set DATABASE_URL for Postgres"})`);
console.log(`Private media root: ${storageDir}`);
console.log("Local Tauri app + loopback relay are unchanged; point the Cloud view at this base URL.");

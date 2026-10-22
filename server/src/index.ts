import { resolve } from "node:path";
import { MemoryStore, PostgresStore } from "./store.ts";
import { createStorageFromEnv } from "./storage.ts";
import { createSaasApp, validateProductionConfig } from "./app.ts";
import { emailProviderFromEnv } from "./email.ts";

const nodeEnv = process.env["NODE_ENV"] ?? "development";
const port = Number(process.env["LIVE_EDITS_SAAS_PORT"] || process.env["PORT"] || 4290);
const host = process.env["LIVE_EDITS_SAAS_HOST"] || "127.0.0.1";
const databaseUrl = (process.env["DATABASE_URL"] || "").trim();
const storageDir = process.env["LIVE_EDITS_STORAGE_DIR"] || resolve(process.cwd(), "data", "saas-media");
const secret = (process.env["LIVE_EDITS_SESSION_SECRET"] || "").trim() || undefined;
const origins = (process.env["LIVE_EDITS_CORS_ORIGINS"] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Fail closed in production: missing secrets, insecure cookies, absent
// database, or no recovery-mail provider refuse startup (see
// validateProductionConfig). Non-production warns and uses safe defaults.
const { provider: email, appBaseUrl } = emailProviderFromEnv(process.env);
if (nodeEnv === "production") {
  validateProductionConfig({
    nodeEnv,
    sessionSecret: secret ?? "",
    cookieSecure: (process.env["LIVE_EDITS_COOKIE_SECURE"] ?? "") === "1",
    databaseUrl,
    emailConfigured: (process.env["SMTP_HOST"] || "").trim().length > 0,
    persistentStore: databaseUrl.length > 0,
    appBaseUrl,
  });
}

const store = databaseUrl ? await PostgresStore.connect(databaseUrl) : new MemoryStore();
const storage = await createStorageFromEnv({ storageDir });
await storage.init();

const app = createSaasApp({
  store,
  storage,
  email,
  ...(appBaseUrl ? { appBaseUrl } : {}),
  ...(secret ? { secret } : {}),
  ...(origins.length > 0 ? { corsOrigins: origins } : {}),
  storageDir,
});
const { base } = await app.listen(Number.isFinite(port) ? port : 4290, host);
console.log(`Live Edits SaaS backend at ${base} (${databaseUrl ? "postgres" : "memory store; set DATABASE_URL for Postgres"})`);
console.log(`Media storage: ${storage.describe()}`);
console.log("Local Tauri app + loopback relay are unchanged; point the Cloud view at this base URL.");

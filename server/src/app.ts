import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import type { Store } from "./store.ts";
import { MemoryStore } from "./store.ts";
import { FilesystemStorage, StorageError, s3ConfigFromEnv, connectS3, signMediaUrl, verifyMediaUrl, type MediaStorage } from "./storage.ts";
import { parseServerPack, importServerPack, type ServerPack } from "./packs.ts";
import { OverlayHub, validateTrigger, hostedOverlayHtml, schedulerCoreJs, isTemplateAsset, templatePngBytes } from "./overlays.ts";
import {
  AccountPatchSchema, EmailSchema, LoginSchema, RecoverConfirmSchema, RecoverRequestSchema, RegisterSchema,
  RoleSchema, TriggerPublishSchema, WorkspaceNameSchema,
  SESSION_TTL_MS, RESET_TTL_MS, SIGNED_URL_TTL_MS, WORKSPACE_QUOTA_BYTES, type Role,
} from "./types.ts";
import { hashPassword, verifyPassword, newToken, sha256Hex, csrfTokenFor, tokensEqual } from "./crypto.ts";
import { LoggingEmailProvider, resetUrlFor, type EmailProvider } from "./email.ts";

function sessionTtlMs(): number {
  const raw = Number(process.env["LIVE_EDITS_SESSION_TTL_MS"] ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SESSION_TTL_MS;
}

export interface ProductionConfig {
  nodeEnv: string;
  sessionSecret: string;
  cookieSecure: boolean;
  databaseUrl: string;
  emailConfigured: boolean;
  persistentStore: boolean;
  appBaseUrl: string;
}

function validAppBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Fail-closed production gate. Missing secrets, insecure cookies, absent
 * database configuration, or no recovery-mail provider refuse startup
 * instead of running degraded. Unit-tested in security.test.ts.
 */
export function validateProductionConfig(cfg: ProductionConfig): void {
  if (cfg.nodeEnv !== "production") return;
  const problems: string[] = [];
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
    problems.push("LIVE_EDITS_SESSION_SECRET must be set (32+ characters).");
  }
  if (!cfg.cookieSecure) problems.push("LIVE_EDITS_COOKIE_SECURE=1 is required (HTTPS-only cookies).");
  if (!cfg.databaseUrl) problems.push("DATABASE_URL is required (no memory store in production).");
  if (!cfg.persistentStore) problems.push("A persistent store is required in production.");
  if (!cfg.emailConfigured) problems.push("SMTP_HOST (+ user/pass/from) is required for password recovery.");
  if (!validAppBaseUrl(cfg.appBaseUrl)) problems.push("APP_BASE_URL must be an HTTP(S) URL without credentials, a query, or a fragment.");
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n- ${problems.join("\n- ")}`);
  }
}

export interface SaasOptions {
  store?: Store;
  storage?: MediaStorage;
  secret?: string;
  quotaBytes?: number;
  corsOrigins?: string[];
  storageDir?: string;
  email?: EmailProvider;
  appBaseUrl?: string;
}

const MAX_JSON = 256 * 1024;

interface RateBucket {
  count: number;
  resetAt: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  secureHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Baseline hardening headers for every API response. */
function secureHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if ((process.env["LIVE_EDITS_COOKIE_SECURE"] ?? "") === "1") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_JSON) {
        req.destroy();
        reject(Object.assign(new Error("request too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionTokenOf(req: IncomingMessage): { token: string; via: "bearer" | "cookie" } | null {
  const auth = req.headers.authorization;
  if (auth && /^Bearer /i.test(auth)) {
    const token = auth.replace(/^Bearer /i, "").trim();
    return token ? { token, via: "bearer" } : null;
  }
  const cookies = parseCookies(req);
  const token = cookies["le_session"] || "";
  return token ? { token, via: "cookie" } : null;
}

function sessionCookie(token: string, secure: boolean): string {
  return `le_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs() / 1000)}${secure ? "; Secure" : ""}`;
}

function csrfCookie(csrf: string, secure: boolean): string {
  // Readable by design (double-submit pattern); useless without the session.
  return `le_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs() / 1000)}${secure ? "; Secure" : ""}`;
}

function clearedCookies(secure: boolean): string[] {
  const suffix = `${secure ? "; Secure" : ""}`;
  return [
    `le_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${suffix}`,
    `le_csrf=; Path=/; SameSite=Lax; Max-Age=0${suffix}`,
  ];
}

const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

function parseRange(header: string | undefined, size: number): { start: number; end: number } | { unsatisfiable: true } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    const tail = Number(endStr);
    if (!Number.isInteger(tail) || tail <= 0) return null;
    return { start: Math.max(0, size - tail), end: size - 1 };
  }
  const start = Number(startStr);
  const end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Bounded media serving with Range support and failed-stream handling. A
 * stream error before headers becomes 404; mid-stream it destroys the
 * response so clients never hang on half a file.
 */
function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  storage: MediaStorage,
  workspaceId: string,
  name: string,
  bytes: number,
  mime: string
): void {
  const ranged = parseRange(req.headers.range, bytes);
  if (ranged && "unsatisfiable" in ranged) {
    res.writeHead(416, { "Content-Range": `bytes */${bytes}`, "Accept-Ranges": "bytes" });
    res.end();
    return;
  }
  let stream: NodeJS.ReadableStream;
  try {
    stream = ranged ? storage.stream(workspaceId, name, { start: ranged.start, end: ranged.end }) : storage.stream(workspaceId, name);
  } catch {
    if (!res.headersSent) json(res, 404, { error: "not found" });
    return;
  }
  let headersSent = false;
  stream.on("error", () => {
    if (!headersSent) {
      if (!res.headersSent) json(res, 404, { error: "not found" });
    } else {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    }
  });
  req.on("close", () => {
    try {
      (stream as unknown as { destroy: () => void }).destroy();
    } catch {
      // ignore
    }
  });
  if (ranged) {
    headersSent = true;
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Length": String(ranged.end - ranged.start + 1),
      "Content-Range": `bytes ${ranged.start}-${ranged.end}/${bytes}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    });
    stream.pipe(res);
    return;
  }
  headersSent = true;
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(bytes),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
  });
  stream.pipe(res);
}

export interface Authed {
  userId: string;
  email: string;
  displayName: string;
}

type SessionInfo = Authed & { tokenHash: string; sessionId: string; via: "bearer" | "cookie"; rawToken: string };

export function createSaasApp(opts: SaasOptions = {}): {
  server: Server;
  listen: (port?: number, host?: string) => Promise<{ port: number; base: string }>;
  close: () => Promise<void>;
  store: Store;
  hub: OverlayHub;
  secret: string;
} {
  const store: Store = opts.store ?? new MemoryStore();
  const storage: MediaStorage = opts.storage ?? new FilesystemStorage(opts.storageDir ?? "./data/saas-media");
  const secret = opts.secret ?? randomBytes(32).toString("hex");
  const quotaBytes = opts.quotaBytes ?? WORKSPACE_QUOTA_BYTES;
  const corsOrigins = new Set(opts.corsOrigins ?? ["http://localhost:1420", "http://127.0.0.1:1420", "http://tauri.localhost", "tauri://localhost"]);
  const cookieSecure = (process.env["LIVE_EDITS_COOKIE_SECURE"] ?? "") === "1";
  const email: EmailProvider = opts.email ?? new LoggingEmailProvider();
  const configuredBaseUrl = (opts.appBaseUrl ?? process.env["APP_BASE_URL"] ?? "").trim();
  if (configuredBaseUrl && !validAppBaseUrl(configuredBaseUrl)) throw new Error("APP_BASE_URL must be an HTTP(S) URL without credentials, a query, or a fragment.");
  if (!configuredBaseUrl && process.env["NODE_ENV"] === "production") throw new Error("APP_BASE_URL is required for password recovery in production.");
  const appBaseUrl = configuredBaseUrl || "http://127.0.0.1:1420";
  const bootId = randomBytes(8).toString("hex");
  const hub = new OverlayHub(bootId);
  const buckets = new Map<string, RateBucket>();
  void storage.init().catch(() => undefined);
  void connectS3(s3ConfigFromEnv());

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Filename, X-CSRF-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  /** Per-key sliding-window limiter. Returns retry-after seconds when limited. */
  function limited(key: string, max: number, windowMs = 60_000): number {
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 10000) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      return 0;
    }
    entry.count += 1;
    if (entry.count > max) return Math.ceil((entry.resetAt - now) / 1000);
    return 0;
  }

  function limitHit(res: ServerResponse, retryAfter: number): boolean {
    if (retryAfter <= 0) return false;
    res.setHeader("Retry-After", String(retryAfter));
    json(res, 429, { error: "too many attempts" });
    return true;
  }

  async function authed(req: IncomingMessage): Promise<SessionInfo | null> {
    const presented = sessionTokenOf(req);
    if (!presented) return null;
    const hash = sha256Hex(presented.token);
    const session = await store.findSessionByHash(hash);
    if (!session || Date.now() > session.expiresAt) return null;
    const user = await store.findUserById(session.userId);
    if (!user) return null;
    await store.touchSession(session.id);
    return { userId: user.id, email: user.email, displayName: user.displayName, tokenHash: hash, sessionId: session.id, via: presented.via, rawToken: presented.token };
  }

  /**
   * CSRF gate for cookie-authenticated mutating requests. Bearer requests
   * carry no ambient credentials and are exempt. Returns true when the
   * request may proceed (sends 403 otherwise).
   */
  function csrfOk(req: IncomingMessage, res: ServerResponse, session: SessionInfo): boolean {
    if (session.via === "bearer") return true;
    const header = req.headers["x-csrf-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented || !tokensEqual(presented, csrfTokenFor(secret, session.rawToken))) {
      json(res, 403, { error: "csrf required" });
      return false;
    }
    return true;
  }

  async function membership(workspaceId: string, userId: string): Promise<{ role: Role } | null> {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(workspaceId)) return null;
    const ws = await store.findWorkspace(workspaceId);
    if (!ws) return null;
    const m = await store.findMembership(workspaceId, userId);
    return m ? { role: m.role } : null;
  }

  const server = createServer(async (req, res) => {
    try {
      cors(req, res);
      secureHeaders(res);
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const method = (req.method || "GET").toUpperCase();
      const ip = req.socket.remoteAddress || "unknown";
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, bootId, connectedOverlays: hub.connectedOverlays(), time: new Date().toISOString() });
      }

      // ---- auth (public entry points: no session required) ----
      if (url.pathname === "/api/auth/register" && method === "POST") {
        if (limitHit(res, limited(`reg:${ip}`, 10))) return;
        const input = RegisterSchema.parse(await readJson(req));
        const existing = await store.findUserByEmail(input.email);
        if (existing) return json(res, 409, { error: "email taken" });
        const user = await store.createUser(input.email, hashPassword(input.password), input.displayName || "");
        const token = newToken();
        await store.createSession(user.id, sha256Hex(token), Date.now() + sessionTtlMs());
        await store.recordAudit({ workspaceId: null, actorId: user.id, action: "auth.register", target: user.id, meta: {} });
        res.setHeader("Set-Cookie", [sessionCookie(token, cookieSecure), csrfCookie(csrfTokenFor(secret, token), cookieSecure)]);
        return json(res, 201, { user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt }, token, csrfToken: csrfTokenFor(secret, token) });
      }
      if (url.pathname === "/api/auth/login" && method === "POST") {
        if (limitHit(res, limited(`login:${ip}`, 10))) return;
        const input = LoginSchema.parse(await readJson(req));
        const user = await store.findUserByEmail(input.email);
        if (!user || !verifyPassword(input.password, user.passwordHash)) {
          return json(res, 401, { error: "invalid credentials" });
        }
        const token = newToken();
        await store.createSession(user.id, sha256Hex(token), Date.now() + sessionTtlMs());
        res.setHeader("Set-Cookie", [sessionCookie(token, cookieSecure), csrfCookie(csrfTokenFor(secret, token), cookieSecure)]);
        return json(res, 200, { user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt }, token, csrfToken: csrfTokenFor(secret, token) });
      }
      if (url.pathname === "/api/auth/logout" && method === "POST") {
        const presented = sessionTokenOf(req);
        const a = await authed(req);
        if (a && presented?.via === "cookie" && !csrfOk(req, res, a)) return;
        if (presented) await store.deleteSessionByHash(sha256Hex(presented.token));
        res.setHeader("Set-Cookie", clearedCookies(cookieSecure));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/auth/me" && method === "GET") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        const user = await store.findUserById(a.userId);
        if (!user) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt } });
      }
      if (url.pathname === "/api/auth/recover/request" && method === "POST") {
        if (limitHit(res, limited(`rec:${ip}`, 5))) return;
        const input = RecoverRequestSchema.parse(await readJson(req));
        const user = await store.findUserByEmail(input.email);
        // Always ok: no account enumeration. The token travels by email only.
        if (user) {
          const token = newToken(24);
          await store.createReset(user.id, sha256Hex(token), Date.now() + RESET_TTL_MS);
          await store.recordAudit({ workspaceId: null, actorId: user.id, action: "auth.recover.request", target: user.id, meta: {} });
          await email.sendPasswordReset(user.email, resetUrlFor(appBaseUrl, token), Date.now() + RESET_TTL_MS);
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/auth/recover/confirm" && method === "POST") {
        const input = RecoverConfirmSchema.parse(await readJson(req));
        const tokenHash = sha256Hex(input.token);
        const row = await store.findResetByHash(tokenHash);
        if (!row || row.usedAt !== null || Date.now() > row.expiresAt) return json(res, 400, { error: "invalid or expired token" });
        const userId = await store.consumeReset(tokenHash, hashPassword(input.newPassword));
        if (!userId) return json(res, 400, { error: "invalid or expired token" });
        await store.recordAudit({ workspaceId: null, actorId: userId, action: "auth.recover.confirm", target: userId, meta: {} });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/auth/account" && method === "PATCH") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        if (!csrfOk(req, res, a)) return;
        const input = AccountPatchSchema.parse(await readJson(req));
        const user = await store.findUserById(a.userId);
        if (!user) return json(res, 401, { error: "unauthorized" });
        if (input.newPassword !== undefined) {
          if (!input.currentPassword || !verifyPassword(input.currentPassword, user.passwordHash)) {
            return json(res, 401, { error: "current password required" });
          }
          await store.updateUser(user.id, { passwordHash: hashPassword(input.newPassword) });
          await store.deleteSessionsForUser(user.id);
          const token = newToken();
          await store.createSession(user.id, sha256Hex(token), Date.now() + sessionTtlMs());
          res.setHeader("Set-Cookie", [sessionCookie(token, cookieSecure), csrfCookie(csrfTokenFor(secret, token), cookieSecure)]);
          await store.recordAudit({ workspaceId: null, actorId: user.id, action: "auth.password.change", target: user.id, meta: {} });
          const updated = await store.findUserById(user.id);
          return json(res, 200, { user: { id: user!.id, email: user!.email, displayName: updated!.displayName, createdAt: user!.createdAt }, token, csrfToken: csrfTokenFor(secret, token) });
        }
        const updated = await store.updateUser(user.id, { displayName: input.displayName ?? user.displayName });
        return json(res, 200, { user: { id: user!.id, email: user!.email, displayName: updated!.displayName, createdAt: user!.createdAt } });
      }
      if (url.pathname === "/api/auth/sessions" && method === "GET") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        const rows = await store.listSessions(a.userId);
        return json(res, 200, { sessions: rows.map((s) => ({ id: s.id, current: s.id === a.sessionId, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })) });
      }
      if (url.pathname === "/api/auth/sessions" && method === "DELETE") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        if (!csrfOk(req, res, a)) return;
        const revokeAll = url.searchParams.get("all") === "1";
        if (revokeAll) {
          await store.deleteSessionsForUser(a.userId);
          res.setHeader("Set-Cookie", clearedCookies(cookieSecure));
        } else {
          await store.deleteOtherSessions(a.userId, a.sessionId);
        }
        await store.recordAudit({ workspaceId: null, actorId: a.userId, action: "auth.sessions.revoke", target: a.userId, meta: { all: revokeAll } });
        return json(res, 200, { revoked: revokeAll ? "all" : "others" });
      }

      // ---- workspaces ----
      if (url.pathname === "/api/workspaces" && method === "POST") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        if (!csrfOk(req, res, a)) return;
        const body = (await readJson(req)) as { name?: unknown };
        const name = WorkspaceNameSchema.parse(body.name);
        const ws = await store.createWorkspace(name, a.userId);
        await store.recordAudit({ workspaceId: ws.id, actorId: a.userId, action: "workspace.create", target: ws.id, meta: { name } });
        return json(res, 201, { workspace: { id: ws.id, name: ws.name, role: "owner" as Role, activePackUid: ws.activePackUid, createdAt: ws.createdAt, updatedAt: ws.updatedAt } });
      }
      if (url.pathname === "/api/workspaces" && method === "GET") {
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        const list = await store.listWorkspacesForUser(a.userId);
        return json(res, 200, { workspaces: list.map((e) => ({ id: e.workspace.id, name: e.workspace.name, role: e.role, activePackUid: e.workspace.activePackUid, createdAt: e.workspace.createdAt, updatedAt: e.workspace.updatedAt })) });
      }

      const wsMatch = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (wsMatch) {
        const workspaceId = decodeURIComponent(wsMatch[1] ?? "");
        const rest = wsMatch[2] ?? "";
        const a = await authed(req);
        if (!a) return json(res, 401, { error: "unauthorized" });
        const mem = await membership(workspaceId, a.userId);
        // 404 for missing workspace AND non-members: prevents id enumeration.
        if (!mem) {
          const workspace = /^[0-9a-fA-F-]{8,64}$/.test(workspaceId) ? await store.findWorkspace(workspaceId) : null;
          await store.recordAudit({ workspaceId: workspace?.id ?? null, actorId: a.userId, action: "workspace.denied", target: url.pathname, meta: { requestedWorkspaceId: workspaceId } });
          return json(res, 404, { error: "not found" });
        }
        // Cookie-authenticated writes need a CSRF token; Bearer calls are exempt.
        if ((method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") && !csrfOk(req, res, a)) return;
        const need = (role: Role): boolean => ROLE_RANK[mem.role] >= ROLE_RANK[role];

        if ((rest === "" || rest === "/") && method === "GET") {
          const ws = await store.findWorkspace(workspaceId);
          return json(res, 200, { workspace: { id: ws!.id, name: ws!.name, role: mem.role, activePackUid: ws!.activePackUid, createdAt: ws!.createdAt, updatedAt: ws!.updatedAt } });
        }
        if (rest === "/members" && method === "GET") {
          const members = await store.listMembers(workspaceId);
          const detailed = await Promise.all(members.map(async (m) => {
            const u = await store.findUserById(m.userId);
            return { userId: m.userId, email: u?.email ?? "", displayName: u?.displayName ?? "", role: m.role, createdAt: m.createdAt };
          }));
          return json(res, 200, { members: detailed });
        }
        if (rest === "/members" && method === "POST") {
          if (!need("owner")) return json(res, 403, { error: "owner only" });
          const body = (await readJson(req)) as { email?: unknown; role?: unknown };
          const email = EmailSchema.parse(body.email);
          const role = RoleSchema.parse(body.role ?? "member");
          const user = await store.findUserByEmail(email);
          if (!user) return json(res, 404, { error: "no such user" });
          if (role === "owner") {
            // Only an owner can grant ownership; allowed.
          }
          let m;
          try {
            m = await store.addMember(workspaceId, user.id, role);
          } catch (err) {
            if ((err as { code?: string }).code === "conflict") return json(res, 409, { error: (err as Error).message });
            throw err;
          }
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "workspace.member.add", target: user.id, meta: { role } });
          return json(res, 201, { member: { userId: m.userId, role: m.role } });
        }
        const memberDel = /^\/members\/([^/]+)$/.exec(rest);
        if (memberDel && method === "DELETE") {
          if (!need("owner")) return json(res, 403, { error: "owner only" });
          const targetId = decodeURIComponent(memberDel[1] ?? "");
          try {
            const ok = await store.removeMember(workspaceId, targetId);
            if (!ok) return json(res, 404, { error: "not found" });
          } catch (err) {
            return json(res, 409, { error: (err as Error).message });
          }
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "workspace.member.remove", target: targetId, meta: {} });
          return json(res, 200, { removed: true });
        }
        if (rest === "/activate" && method === "POST") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const body = (await readJson(req)) as { packUid?: unknown };
          const packUid = body.packUid == null ? null : z.string().min(1).parse(body.packUid);
          try {
            const ws = await store.setActivePack(workspaceId, packUid);
            await store.recordAudit({ workspaceId, actorId: a.userId, action: "workspace.activate", target: packUid ?? "", meta: {} });
            return json(res, 200, { workspace: { id: ws!.id, activePackUid: ws!.activePackUid } });
          } catch {
            return json(res, 404, { error: "no such pack" });
          }
        }

        // ---- packs ----
        if (rest === "/packs" && method === "GET") {
          const packs = await store.listPacks(workspaceId);
          return json(res, 200, { packs: packs.map((p) => ({ packUid: p.packUid, name: p.name, version: p.version, updatedAt: p.updatedAt })) });
        }
        if (rest === "/packs" && method === "POST") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const pack = parseServerPack(await readJson(req));
          const row = await store.upsertPack(workspaceId, pack.id, pack.name, pack.version, pack, a.userId);
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "pack.save", target: pack.id, meta: { name: pack.name } });
          return json(res, 201, { pack: { packUid: row.packUid, name: row.name, version: row.version, data: row.data, updatedAt: row.updatedAt } });
        }
        if (rest === "/packs/import" && method === "POST") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const body = (await readJson(req)) as { data?: unknown };
          const existingPacks = await store.listPacks(workspaceId);
          const imported = importServerPack(
            body.data,
            new Set(existingPacks.flatMap((p) => ((p.data as ServerPack).effects ?? []).map((e) => (e as { id: string }).id))),
            new Set(existingPacks.map((p) => p.packUid))
          );
          const row = await store.upsertPack(workspaceId, imported.id, imported.name, imported.version, imported, a.userId);
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "pack.import", target: imported.id, meta: {} });
          return json(res, 201, { pack: { packUid: row.packUid, name: row.name, version: row.version, data: row.data, updatedAt: row.updatedAt } });
        }
        const packMatch = /^\/packs\/([^/]+)(\/.*)?$/.exec(rest);
        if (packMatch) {
          const packUid = decodeURIComponent(packMatch[1] ?? "");
          const sub = packMatch[2] ?? "";
          if (sub === "" && method === "GET") {
            const row = await store.findPack(workspaceId, packUid);
            if (!row) return json(res, 404, { error: "not found" });
            return json(res, 200, { pack: { packUid: row.packUid, name: row.name, version: row.version, data: row.data, updatedAt: row.updatedAt } });
          }
          if (sub === "" && method === "PUT") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            const pack = parseServerPack(await readJson(req));
            if (pack.id !== packUid) return json(res, 400, { error: "pack id mismatch" });
            const row = await store.upsertPack(workspaceId, pack.id, pack.name, pack.version, pack, a.userId);
            await store.recordAudit({ workspaceId, actorId: a.userId, action: "pack.save", target: pack.id, meta: {} });
            return json(res, 200, { pack: { packUid: row.packUid, name: row.name, version: row.version, data: row.data, updatedAt: row.updatedAt } });
          }
          if (sub === "" && method === "DELETE") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            const ok = await store.deletePack(workspaceId, packUid);
            if (!ok) return json(res, 404, { error: "not found" });
            await store.recordAudit({ workspaceId, actorId: a.userId, action: "pack.delete", target: packUid, meta: {} });
            return json(res, 200, { removed: true });
          }
          if (sub === "/export" && method === "GET") {
            const row = await store.findPack(workspaceId, packUid);
            if (!row) return json(res, 404, { error: "not found" });
            // Export shape is byte-compatible with local serializePack output.
            return json(res, 200, row.data);
          }
        }

        // ---- media ----
        if (rest === "/media" && method === "GET") {
          const items = await store.listMedia(workspaceId);
          return json(res, 200, { media: items.map((m) => ({ name: m.name, bytes: m.bytes, kind: m.kind, mime: m.mime, version: m.version, createdAt: m.createdAt })) });
        }
        if (rest === "/media" && method === "POST") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const result = await store.withMediaLock(workspaceId, async (media) => {
            const rawName = req.headers["x-filename"];
            const filename = Array.isArray(rawName) ? rawName[0] : rawName;
            if (!filename) return { status: 400, body: { error: "missing X-Filename" } };
            const name = decodeURIComponent(filename);
            const existing = await media.findMedia(workspaceId, name);
            if (existing) return { status: 409, body: { error: "exists", existing: { name, bytes: existing.bytes } } };
            const declared = Number(req.headers["content-length"]);
            const usage = await media.workspaceMediaBytes(workspaceId);
            try {
              const stored = await storage.put(workspaceId, name, req as unknown as AsyncIterable<Uint8Array>, Number.isFinite(declared) ? declared : null, usage, quotaBytes);
              const row = await media.createMedia({ workspaceId, name, bytes: stored.bytes, kind: stored.kind, mime: String(req.headers["content-type"] || ""), version: stored.version, storageKey: stored.storageKey, uploadedBy: a.userId });
              await media.recordAudit({ workspaceId, actorId: a.userId, action: "media.upload", target: name, meta: { bytes: stored.bytes } });
              return { status: 201, body: { name, bytes: row.bytes, kind: row.kind, mime: row.mime, version: row.version } };
            } catch (err) {
              if (err instanceof StorageError) {
                const status = err.code === "exists" ? 409 : err.code === "quota exceeded" || err.code === "file too large" ? 413 : 400;
                await media.recordAudit({ workspaceId, actorId: a.userId, action: "media.upload.rejected", target: name, meta: { code: err.code } });
                return { status, body: { error: err.code } };
              }
              throw err;
            }
          });
          return json(res, result.status, result.body);
        }
        const mediaMatch = /^\/media\/([^/]+)(\/.*)?$/.exec(rest);
        if (mediaMatch) {
          const mediaName = decodeURIComponent(mediaMatch[1] ?? "");
          const sub = mediaMatch[2] ?? "";
          if (sub === "" && method === "GET") {
            const row = await store.findMedia(workspaceId, mediaName);
            if (!row) return json(res, 404, { error: "not found" });
            serveMedia(req, res, storage, workspaceId, mediaName, row.bytes, row.mime || "application/octet-stream");
            return;
          }
          if (sub === "" && method === "PUT") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            const result = await store.withMediaLock(workspaceId, async (media) => {
              const row = await media.findMedia(workspaceId, mediaName);
              if (!row) return { status: 404, body: { error: "not found" } };
              const declared = Number(req.headers["content-length"]);
              const usage = (await media.workspaceMediaBytes(workspaceId)) - row.bytes;
              try {
                const stored = await storage.replace(workspaceId, mediaName, req as unknown as AsyncIterable<Uint8Array>, Number.isFinite(declared) ? declared : null, usage, quotaBytes, row.version);
                const updated = await media.updateMediaVersion(workspaceId, mediaName, stored.bytes, String(req.headers["content-type"] || row.mime), stored.storageKey);
                await media.recordAudit({ workspaceId, actorId: a.userId, action: "media.replace", target: mediaName, meta: { bytes: stored.bytes, version: updated?.version } });
                return { status: 200, body: { name: mediaName, bytes: stored.bytes, kind: stored.kind, version: updated?.version ?? row.version } };
              } catch (err) {
                if (err instanceof StorageError) {
                  const status = err.code === "quota exceeded" || err.code === "file too large" ? 413 : 400;
                  return { status, body: { error: err.code } };
                }
                throw err;
              }
            });
            return json(res, result.status, result.body);
          }
          if (sub === "" && method === "DELETE") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            const result = await store.withMediaLock(workspaceId, async (media) => {
              const row = await media.deleteMedia(workspaceId, mediaName);
              if (!row) return { status: 404, body: { error: "not found" } };
              await storage.remove(workspaceId, mediaName).catch(() => undefined);
              await media.recordAudit({ workspaceId, actorId: a.userId, action: "media.delete", target: mediaName, meta: {} });
              return { status: 200, body: { removed: true, name: mediaName } };
            });
            return json(res, result.status, result.body);
          }
          if (sub === "/signed-url" && method === "POST") {
            const row = await store.findMedia(workspaceId, mediaName);
            if (!row) return json(res, 404, { error: "not found" });
            const expiresAt = Date.now() + SIGNED_URL_TTL_MS;
            const sig = signMediaUrl(secret, workspaceId, mediaName, expiresAt);
            return json(res, 200, { expiresAt, signature: sig });
          }
        }

        // ---- overlays ----
        if (rest === "/overlays" && method === "GET") {
          const rows = await store.listOverlays(workspaceId);
          return json(res, 200, { overlays: rows.map((o) => ({ id: o.id, name: o.name, revoked: o.revokedAt !== null, createdAt: o.createdAt, rotatedAt: o.rotatedAt })) });
        }
        if (rest === "/overlays" && method === "POST") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const body = (await readJson(req)) as { name?: unknown };
          const name = WorkspaceNameSchema.parse(body.name);
          const viewToken = newToken(24);
          const row = await store.createOverlay(workspaceId, name, sha256Hex(viewToken), a.userId);
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "overlay.create", target: row.id, meta: { name } });
          return json(res, 201, { overlay: { id: row.id, name: row.name }, viewToken });
        }
        const overlayMatch = /^\/overlays\/([^/]+)(\/.*)?$/.exec(rest);
        if (overlayMatch) {
          const oid = decodeURIComponent(overlayMatch[1] ?? "");
          const sub = overlayMatch[2] ?? "";
          const row = await store.findOverlayById(oid);
          if (!row || row.workspaceId !== workspaceId) return json(res, 404, { error: "not found" });
          if (sub === "/revoke" && method === "POST") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            await store.revokeOverlay(oid);
            hub.dropOverlayClients(workspaceId, oid);
            await store.recordAudit({ workspaceId, actorId: a.userId, action: "overlay.revoke", target: oid, meta: {} });
            return json(res, 200, { revoked: true });
          }
          if (sub === "/rotate" && method === "POST") {
            if (!need("admin")) return json(res, 403, { error: "admin only" });
            const viewToken = newToken(24);
            try {
              await store.rotateOverlayToken(oid, sha256Hex(viewToken));
            } catch {
              return json(res, 409, { error: "revoked" });
            }
            hub.dropOverlayClients(workspaceId, oid);
            await store.recordAudit({ workspaceId, actorId: a.userId, action: "overlay.rotate", target: oid, meta: {} });
            return json(res, 200, { rotated: true, viewToken });
          }
        }

        // ---- trigger ----
        if (rest === "/trigger" && method === "POST") {
          if (limitHit(res, limited(`trig:${ip}:${workspaceId}`, 120))) return;
          const body = await readJson(req);
          let parsed;
          try {
            parsed = validateTrigger(body);
          } catch (err) {
            await store.recordTrigger({ workspaceId, effectUid: null, moment: "wow", templateId: null, dedupKey: null, status: "rejected", delivered: 0, createdBy: a.userId });
            const code = (err as { code?: string }).code === "expired" ? "expired" : "invalid reaction";
            return json(res, 400, { error: code });
          }
          const dedupKey = parsed.dedupKey ?? parsed.triggerId ?? null;
          if (dedupKey && !hub.noteDedup(workspaceId, dedupKey)) {
            await store.recordTrigger({ workspaceId, effectUid: parsed.effectId ?? null, moment: parsed.moment, templateId: parsed.templateId, dedupKey, status: "duplicate", delivered: 0, createdBy: a.userId });
            return json(res, 202, { accepted: false, duplicate: true, connectedOverlays: hub.connectedOverlays(workspaceId) });
          }
          if (dedupKey) {
            const prior = await store.findTriggerByDedup(workspaceId, dedupKey);
            if (prior) {
              await store.recordTrigger({ workspaceId, effectUid: parsed.effectId ?? null, moment: parsed.moment, templateId: parsed.templateId, dedupKey, status: "duplicate", delivered: 0, createdBy: a.userId });
              return json(res, 202, { accepted: false, duplicate: true, connectedOverlays: hub.connectedOverlays(workspaceId) });
            }
          }
          // Resolve the effect through the active pack; V1 fallback otherwise.
          // An explicitly referenced effect wins; otherwise the pack
          // assignment for (manual, moment) — exact moment first, then
          // source wildcards — supplies the FULL playback configuration
          // (media, duration, volume, trim, position, queue, priority,
          // cooldown), exactly like the local pipeline. Caller fields
          // override effect defaults.
          let effect: { id: string; moment: string; mediaFile?: string; durationMs: number; volume: number; muted: boolean; position: string; clipStartMs?: number; clipEndMs?: number; queue: string; priority: number; cooldownMs: number } | null = null;
          const ws = await store.findWorkspace(workspaceId);
          const activeUid = ws?.activePackUid ?? null;
          if (activeUid) {
            const packRow = await store.findPack(workspaceId, activeUid);
            const data = packRow?.data as ServerPack | undefined;
            if (data) {
              const readEffect = (uid: string): typeof effect => {
                const found = data.effects.find((e) => (e as { id: string }).id === uid) as unknown as
                  | { id: string; moment: string; mediaFile?: string; durationMs: number; volume?: number; muted?: boolean; position?: string; clipStartMs?: number; clipEndMs?: number; queue: string; priority: number; cooldownMs: number; enabled?: boolean }
                  | undefined;
                if (!found || found.enabled === false) return null;
                return { id: found.id, moment: found.moment, mediaFile: found.mediaFile, durationMs: found.durationMs, volume: found.volume ?? 1, muted: found.muted ?? false, position: found.position ?? "center", clipStartMs: found.clipStartMs, clipEndMs: found.clipEndMs, queue: found.queue, priority: found.priority, cooldownMs: found.cooldownMs };
              };
              if (parsed.effectId) {
                const found = readEffect(parsed.effectId);
                if (!found) {
                  await store.recordTrigger({ workspaceId, effectUid: parsed.effectId, moment: parsed.moment, templateId: parsed.templateId, dedupKey, status: "rejected", delivered: 0, createdBy: a.userId });
                  return json(res, 400, { error: "unknown effect" });
                }
                effect = found;
              } else {
                const assignments = (data.assignments ?? []) as Array<{ source: string; moment?: string; effectId: string }>;
                const match = assignments.find((x) => x.source === "manual" && x.moment === parsed.moment)
                  ?? assignments.find((x) => x.source === "manual" && x.moment === undefined);
                if (match) effect = readEffect(match.effectId);
              }
            }
          }
          const mediaFile = parsed.mediaFile ?? effect?.mediaFile ?? null;
          if (mediaFile) {
            const media = await store.findMedia(workspaceId, mediaFile);
            if (!media) {
              await store.recordTrigger({ workspaceId, effectUid: parsed.effectId ?? null, moment: parsed.moment, templateId: parsed.templateId, dedupKey, status: "rejected", delivered: 0, createdBy: a.userId });
              return json(res, 400, { error: "missing media file" });
            }
          }
          const sequence = hub.nextSequence(workspaceId);
          const event = {
            bootId, sequence, at: Date.now(),
            moment: effect?.moment ?? parsed.moment,
            templateId: parsed.templateId,
            mediaFile,
            mediaUrl: null as string | null,
            durationMs: parsed.durationMs ?? effect?.durationMs ?? 2700,
            volume: parsed.volume ?? effect?.volume ?? 1,
            muted: parsed.muted ?? effect?.muted ?? false,
            clipStartMs: parsed.clipStartMs ?? effect?.clipStartMs ?? null,
            clipEndMs: parsed.clipEndMs ?? effect?.clipEndMs ?? null,
            position: parsed.position ?? effect?.position ?? "center",
            queue: parsed.queue ?? effect?.queue ?? "replace",
            priority: parsed.priority ?? effect?.priority ?? 50,
            cooldownMs: parsed.cooldownMs ?? effect?.cooldownMs ?? 0,
            effectId: parsed.effectId ?? effect?.id ?? null,
            triggerId: parsed.triggerId ?? null,
            dedupKey,
            expiresAt: parsed.expiresAt ?? null,
            sequenceNumber: parsed.sequenceNumber ?? null,
          };
          const delivered = hub.broadcast(workspaceId, event);
          await store.recordTrigger({ workspaceId, effectUid: event.effectId, moment: event.moment, templateId: event.templateId, dedupKey, status: "accepted", delivered, createdBy: a.userId });
          await store.recordAudit({ workspaceId, actorId: a.userId, action: "trigger.fire", target: event.effectId ?? event.templateId, meta: { delivered } });
          return json(res, 202, { accepted: true, sequence, bootId, connectedOverlays: hub.connectedOverlays(workspaceId) });
        }
        if (rest === "/triggers" && method === "GET") {
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
          const rows = await store.listTriggers(workspaceId, limit);
          return json(res, 200, { triggers: rows });
        }
        if (rest === "/audit" && method === "GET") {
          if (!need("admin")) return json(res, 403, { error: "admin only" });
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
          const rows = await store.listAudit(workspaceId, limit);
          return json(res, 200, { audit: rows });
        }

        return json(res, 404, { error: "not found" });
      }

      // ---- hosted overlay surface (view-token auth, workspace isolated) ----
      const overlayPage = /^\/o\/([^/]+)$/.exec(url.pathname);
      if (overlayPage && method === "GET") {
        const oid = decodeURIComponent(overlayPage[1] ?? "");
        const token = url.searchParams.get("token") ?? "";
        const row = await store.findOverlayByTokenHash(sha256Hex(token));
        if (!token || !row || row.id !== oid || row.revokedAt) return json(res, 403, { error: "forbidden" });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self';",
        });
        res.end(hostedOverlayHtml(row.id));
        return;
      }
      const overlayJs = /^\/o\/([^/]+)\/scheduler-core\.js$/.exec(url.pathname);
      if (overlayJs && method === "GET") {
        const body = await schedulerCoreJs();
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" });
        res.end(body);
        return;
      }
      const overlayTemplate = /^\/o\/([^/]+)\/templates\/([^/]+)$/.exec(url.pathname);
      if (overlayTemplate && method === "GET") {
        // Bundled template art (public assets, like the local relay's
        // /templates): proves identity via a known overlay id, no view
        // token needed for non-secret frame art.
        const oid = decodeURIComponent(overlayTemplate[1] ?? "");
        const asset = overlayTemplate[2] ?? "";
        const row = await store.findOverlayById(oid);
        if (!row || !isTemplateAsset(asset)) return json(res, 404, { error: "not found" });
        try {
          const png = await templatePngBytes(asset);
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
          res.end(png);
        } catch {
          return json(res, 404, { error: "not found" });
        }
        return;
      }
      const overlayEvents = /^\/o\/([^/]+)\/events$/.exec(url.pathname);
      if (overlayEvents && method === "GET") {
        const oid = decodeURIComponent(overlayEvents[1] ?? "");
        const token = url.searchParams.get("token") ?? "";
        const row = await store.findOverlayByTokenHash(sha256Hex(token));
        if (!token || !row || row.id !== oid || row.revokedAt) return json(res, 403, { error: "forbidden" });
        if (!hub.addClient(row.workspaceId, row.id, res)) return json(res, 503, { error: "too many overlays" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        res.write(`id: 0\nevent: hello\ndata: ${JSON.stringify({ bootId, workspaceId: row.workspaceId, overlayId: row.id })}\n\n`);
        const ping = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            clearInterval(ping);
          }
        }, 15000);
        req.on("close", () => {
          clearInterval(ping);
          hub.removeClient(row.workspaceId, res);
        });
        return;
      }
      const overlayMedia = /^\/o\/([^/]+)\/media\/([^/]+)$/.exec(url.pathname);
      if (overlayMedia && method === "GET") {
        const oid = decodeURIComponent(overlayMedia[1] ?? "");
        const mediaName = decodeURIComponent(overlayMedia[2] ?? "");
        const token = url.searchParams.get("token") ?? "";
        const sig = url.searchParams.get("sig") ?? "";
        const exp = Number(url.searchParams.get("exp") ?? 0);
        const row = await store.findOverlayByTokenHash(sha256Hex(token));
        let workspaceId: string | null = null;
        if (row && row.id === oid && !row.revokedAt) {
          workspaceId = row.workspaceId;
        } else if (sig && Number.isInteger(exp)) {
          // Signed-URL mode: find owning workspace by scanning overlays is
          // wasteful; instead verify against the overlay's workspace.
          const byId = await store.findOverlayById(oid);
          if (byId && !byId.revokedAt) {
            if (verifyMediaUrl(secret, byId.workspaceId, mediaName, exp, sig)) workspaceId = byId.workspaceId;
          }
        }
        if (!workspaceId) return json(res, 403, { error: "forbidden" });
        const media = await store.findMedia(workspaceId, mediaName);
        if (!media) return json(res, 404, { error: "not found" });
        serveMedia(req, res, storage, workspaceId, mediaName, media.bytes, media.mime || "application/octet-stream");
        return;
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (!res.headersSent) {
        const error = err as Error & { status?: number; issues?: unknown; name?: string };
        const isZod = error.name === "ZodError" || error.issues !== undefined;
        const status = error.status ?? (isZod ? 400 : /expired|invalid|malformed|mismatch|taken|exists|Duplicate|missing|unknown/i.test(error.message) ? 400 : 500);
        if (status === 500 && process.env["NODE_ENV"] !== "test") console.error("SaaS backend:", err);
        json(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  });

  const listen = (port = 0, host = "127.0.0.1"): Promise<{ port: number; base: string }> =>
    new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        const bound = typeof address === "object" && address ? address.port : port;
        resolvePromise({ port: bound, base: `http://${host}:${bound}` });
      });
    });
  const close = (): Promise<void> =>
    new Promise((resolvePromise, reject) => {
      try {
        const maybe = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
        if (typeof maybe === "function") {
          try {
            maybe.call(server);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      server.close((err) => (err ? reject(err) : resolvePromise()));
    });

  return { server, listen, close, store, hub, secret };
}

export { TriggerPublishSchema };

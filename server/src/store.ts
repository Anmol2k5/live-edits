import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Role } from "./types.ts";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResetRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  ownerId: string;
  activePackUid: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipRow {
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

export interface PackRow {
  id: string;
  workspaceId: string;
  packUid: string;
  name: string;
  version: number;
  data: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaRow {
  id: string;
  workspaceId: string;
  name: string;
  bytes: number;
  kind: "video" | "audio" | "image";
  mime: string;
  version: number;
  storageKey: string;
  uploadedBy: string | null;
  createdAt: string;
}

export interface OverlayRow {
  id: string;
  workspaceId: string;
  name: string;
  viewTokenHash: string;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

export interface TriggerRow {
  id: string;
  workspaceId: string;
  effectUid: string | null;
  moment: string;
  templateId: string | null;
  dedupKey: string | null;
  status: "accepted" | "duplicate" | "rejected";
  delivered: number;
  createdBy: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  target: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Async store so memory (tests/dev) and Postgres (production) share one API. */
export interface Store {
  createUser(email: string, passwordHash: string, displayName: string): Promise<UserRow>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  updateUser(id: string, patch: { displayName?: string; passwordHash?: string }): Promise<UserRow | null>;
  createReset(userId: string, tokenHash: string, expiresAt: number): Promise<ResetRow>;
  findResetByHash(tokenHash: string): Promise<ResetRow | null>;
  markResetUsed(id: string): Promise<void>;
  createSession(userId: string, tokenHash: string, expiresAt: number): Promise<SessionRow>;
  findSessionByHash(tokenHash: string): Promise<SessionRow | null>;
  touchSession(id: string): Promise<void>;
  deleteSessionByHash(tokenHash: string): Promise<boolean>;
  deleteSessionsForUser(userId: string): Promise<number>;
  createWorkspace(name: string, ownerId: string): Promise<WorkspaceRow>;
  findWorkspace(id: string): Promise<WorkspaceRow | null>;
  listWorkspacesForUser(userId: string): Promise<Array<{ workspace: WorkspaceRow; role: Role }>>;
  setActivePack(workspaceId: string, packUid: string | null): Promise<WorkspaceRow | null>;
  addMember(workspaceId: string, userId: string, role: Role): Promise<MembershipRow>;
  findMembership(workspaceId: string, userId: string): Promise<MembershipRow | null>;
  listMembers(workspaceId: string): Promise<MembershipRow[]>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
  upsertPack(workspaceId: string, packUid: string, name: string, version: number, data: unknown, createdBy: string | null): Promise<PackRow>;
  findPack(workspaceId: string, packUid: string): Promise<PackRow | null>;
  listPacks(workspaceId: string): Promise<PackRow[]>;
  deletePack(workspaceId: string, packUid: string): Promise<boolean>;
  createMedia(row: Omit<MediaRow, "id" | "createdAt">): Promise<MediaRow>;
  updateMediaVersion(workspaceId: string, name: string, bytes: number, mime: string, storageKey: string): Promise<MediaRow | null>;
  findMedia(workspaceId: string, name: string): Promise<MediaRow | null>;
  listMedia(workspaceId: string): Promise<MediaRow[]>;
  deleteMedia(workspaceId: string, name: string): Promise<MediaRow | null>;
  workspaceMediaBytes(workspaceId: string): Promise<number>;
  createOverlay(workspaceId: string, name: string, viewTokenHash: string, createdBy: string | null): Promise<OverlayRow>;
  findOverlayById(id: string): Promise<OverlayRow | null>;
  findOverlayByTokenHash(hash: string): Promise<OverlayRow | null>;
  listOverlays(workspaceId: string): Promise<OverlayRow[]>;
  revokeOverlay(id: string): Promise<OverlayRow | null>;
  rotateOverlayToken(id: string, newHash: string): Promise<OverlayRow | null>;
  recordTrigger(row: Omit<TriggerRow, "id" | "createdAt">): Promise<TriggerRow>;
  findTriggerByDedup(workspaceId: string, key: string): Promise<TriggerRow | null>;
  listTriggers(workspaceId: string, limit: number): Promise<TriggerRow[]>;
  recordAudit(row: Omit<AuditRow, "id" | "createdAt">): Promise<AuditRow>;
  listAudit(workspaceId: string, limit: number): Promise<AuditRow[]>;
}

export class MemoryStore implements Store {
  private users = new Map<string, UserRow>();
  private usersByEmail = new Map<string, string>();
  private resets = new Map<string, ResetRow>();
  private resetsByHash = new Map<string, string>();
  private sessions = new Map<string, SessionRow>();
  private sessionsByHash = new Map<string, string>();
  private workspaces = new Map<string, WorkspaceRow>();
  private memberships = new Map<string, MembershipRow>();
  private packs = new Map<string, PackRow>();
  private media = new Map<string, MediaRow>();
  private overlays = new Map<string, OverlayRow>();
  private overlaysByHash = new Map<string, string>();
  private triggers: TriggerRow[] = [];
  private audits: AuditRow[] = [];

  async createUser(email: string, passwordHash: string, displayName: string): Promise<UserRow> {
    const norm = normEmail(email);
    if (this.usersByEmail.has(norm)) throw conflict("email taken");
    const row: UserRow = { id: randomUUID(), email: email.trim(), passwordHash, displayName, createdAt: nowIso(), updatedAt: nowIso() };
    this.users.set(row.id, row);
    this.usersByEmail.set(norm, row.id);
    return row;
  }
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const id = this.usersByEmail.get(normEmail(email));
    return (id && this.users.get(id)) || null;
  }
  async findUserById(id: string): Promise<UserRow | null> {
    return this.users.get(id) || null;
  }
  async updateUser(id: string, patch: { displayName?: string; passwordHash?: string }): Promise<UserRow | null> {
    const row = this.users.get(id);
    if (!row) return null;
    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.passwordHash !== undefined) row.passwordHash = patch.passwordHash;
    row.updatedAt = nowIso();
    return row;
  }
  async createReset(userId: string, tokenHash: string, expiresAt: number): Promise<ResetRow> {
    if (!this.users.has(userId)) throw conflict("no user");
    if (this.resetsByHash.has(tokenHash)) throw conflict("reset exists");
    const row: ResetRow = { id: randomUUID(), userId, tokenHash, expiresAt, usedAt: null, createdAt: Date.now() };
    this.resets.set(row.id, row);
    this.resetsByHash.set(tokenHash, row.id);
    return row;
  }
  async findResetByHash(tokenHash: string): Promise<ResetRow | null> {
    const id = this.resetsByHash.get(tokenHash);
    return (id && this.resets.get(id)) || null;
  }
  async markResetUsed(id: string): Promise<void> {
    const row = this.resets.get(id);
    if (row) row.usedAt = Date.now();
  }
  async createSession(userId: string, tokenHash: string, expiresAt: number): Promise<SessionRow> {
    if (!this.users.has(userId)) throw conflict("no user");
    if (this.sessionsByHash.has(tokenHash)) throw conflict("session exists");
    const row: SessionRow = { id: randomUUID(), userId, tokenHash, expiresAt, createdAt: Date.now(), lastSeenAt: Date.now() };
    this.sessions.set(row.id, row);
    this.sessionsByHash.set(tokenHash, row.id);
    return row;
  }
  async findSessionByHash(tokenHash: string): Promise<SessionRow | null> {
    const id = this.sessionsByHash.get(tokenHash);
    return (id && this.sessions.get(id)) || null;
  }
  async touchSession(id: string): Promise<void> {
    const row = this.sessions.get(id);
    if (row) row.lastSeenAt = Date.now();
  }
  async deleteSessionByHash(tokenHash: string): Promise<boolean> {
    const id = this.sessionsByHash.get(tokenHash);
    if (!id) return false;
    this.sessionsByHash.delete(tokenHash);
    return this.sessions.delete(id);
  }
  async deleteSessionsForUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, row] of [...this.sessions]) {
      if (row.userId === userId) {
        this.sessions.delete(id);
        this.sessionsByHash.delete(row.tokenHash);
        n += 1;
      }
    }
    return n;
  }
  async createWorkspace(name: string, ownerId: string): Promise<WorkspaceRow> {
    if (!this.users.has(ownerId)) throw conflict("no owner");
    const row: WorkspaceRow = { id: randomUUID(), name, ownerId, activePackUid: null, createdAt: nowIso(), updatedAt: nowIso() };
    this.workspaces.set(row.id, row);
    this.memberships.set(`${row.id}:${ownerId}`, { workspaceId: row.id, userId: ownerId, role: "owner", createdAt: nowIso() });
    return row;
  }
  async findWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspaces.get(id) || null;
  }
  async listWorkspacesForUser(userId: string): Promise<Array<{ workspace: WorkspaceRow; role: Role }>> {
    const out: Array<{ workspace: WorkspaceRow; role: Role }> = [];
    for (const m of this.memberships.values()) {
      if (m.userId !== userId) continue;
      const ws = this.workspaces.get(m.workspaceId);
      if (ws) out.push({ workspace: ws, role: m.role });
    }
    return out.sort((a, b) => a.workspace.createdAt.localeCompare(b.workspace.createdAt));
  }
  async setActivePack(workspaceId: string, packUid: string | null): Promise<WorkspaceRow | null> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return null;
    if (packUid !== null && !this.packs.has(`${workspaceId}:${packUid}`)) throw conflict("no pack");
    ws.activePackUid = packUid;
    ws.updatedAt = nowIso();
    return ws;
  }
  async addMember(workspaceId: string, userId: string, role: Role): Promise<MembershipRow> {
    if (!this.workspaces.has(workspaceId)) throw conflict("no workspace");
    if (!this.users.has(userId)) throw conflict("no user");
    const key = `${workspaceId}:${userId}`;
    const existing = this.memberships.get(key);
    if (existing) {
      existing.role = role;
      return existing;
    }
    const row: MembershipRow = { workspaceId, userId, role, createdAt: nowIso() };
    this.memberships.set(key, row);
    return row;
  }
  async findMembership(workspaceId: string, userId: string): Promise<MembershipRow | null> {
    return this.memberships.get(`${workspaceId}:${userId}`) || null;
  }
  async listMembers(workspaceId: string): Promise<MembershipRow[]> {
    return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId);
  }
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const key = `${workspaceId}:${userId}`;
    const existing = this.memberships.get(key);
    if (!existing) return false;
    if (existing.role === "owner") {
      const owners = [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId && m.role === "owner");
      if (owners.length <= 1) throw conflict("last owner");
    }
    return this.memberships.delete(key);
  }
  async upsertPack(workspaceId: string, packUid: string, name: string, version: number, data: unknown, createdBy: string | null): Promise<PackRow> {
    if (!this.workspaces.has(workspaceId)) throw conflict("no workspace");
    const key = `${workspaceId}:${packUid}`;
    const existing = this.packs.get(key);
    if (existing) {
      existing.name = name;
      existing.version = version;
      existing.data = data;
      existing.updatedAt = nowIso();
      return existing;
    }
    const row: PackRow = { id: randomUUID(), workspaceId, packUid, name, version, data, createdBy, createdAt: nowIso(), updatedAt: nowIso() };
    this.packs.set(key, row);
    return row;
  }
  async findPack(workspaceId: string, packUid: string): Promise<PackRow | null> {
    return this.packs.get(`${workspaceId}:${packUid}`) || null;
  }
  async listPacks(workspaceId: string): Promise<PackRow[]> {
    return [...this.packs.values()].filter((p) => p.workspaceId === workspaceId);
  }
  async deletePack(workspaceId: string, packUid: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (ws && ws.activePackUid === packUid) {
      ws.activePackUid = null;
      ws.updatedAt = nowIso();
    }
    return this.packs.delete(`${workspaceId}:${packUid}`);
  }
  async createMedia(row: Omit<MediaRow, "id" | "createdAt">): Promise<MediaRow> {
    if (!this.workspaces.has(row.workspaceId)) throw conflict("no workspace");
    const key = `${row.workspaceId}:${row.name}`;
    if (this.media.has(key)) throw conflict("media exists");
    const full: MediaRow = { ...row, id: randomUUID(), createdAt: nowIso() };
    this.media.set(key, full);
    return full;
  }
  async updateMediaVersion(workspaceId: string, name: string, bytes: number, mime: string, storageKey: string): Promise<MediaRow | null> {
    const row = this.media.get(`${workspaceId}:${name}`);
    if (!row) return null;
    row.bytes = bytes;
    row.mime = mime;
    row.storageKey = storageKey;
    row.version += 1;
    return row;
  }
  async findMedia(workspaceId: string, name: string): Promise<MediaRow | null> {
    return this.media.get(`${workspaceId}:${name}`) || null;
  }
  async listMedia(workspaceId: string): Promise<MediaRow[]> {
    return [...this.media.values()].filter((m) => m.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name));
  }
  async deleteMedia(workspaceId: string, name: string): Promise<MediaRow | null> {
    const row = this.media.get(`${workspaceId}:${name}`);
    if (!row) return null;
    this.media.delete(`${workspaceId}:${name}`);
    return row;
  }
  async workspaceMediaBytes(workspaceId: string): Promise<number> {
    let total = 0;
    for (const m of this.media.values()) if (m.workspaceId === workspaceId) total += m.bytes;
    return total;
  }
  async createOverlay(workspaceId: string, name: string, viewTokenHash: string, createdBy: string | null): Promise<OverlayRow> {
    if (!this.workspaces.has(workspaceId)) throw conflict("no workspace");
    if (this.overlaysByHash.has(viewTokenHash)) throw conflict("overlay exists");
    const row: OverlayRow = { id: randomUUID(), workspaceId, name, viewTokenHash, revokedAt: null, createdBy, createdAt: nowIso(), rotatedAt: null };
    this.overlays.set(row.id, row);
    this.overlaysByHash.set(viewTokenHash, row.id);
    return row;
  }
  async findOverlayById(id: string): Promise<OverlayRow | null> {
    return this.overlays.get(id) || null;
  }
  async findOverlayByTokenHash(hash: string): Promise<OverlayRow | null> {
    const id = this.overlaysByHash.get(hash);
    return (id && this.overlays.get(id)) || null;
  }
  async listOverlays(workspaceId: string): Promise<OverlayRow[]> {
    return [...this.overlays.values()].filter((o) => o.workspaceId === workspaceId);
  }
  async revokeOverlay(id: string): Promise<OverlayRow | null> {
    const row = this.overlays.get(id);
    if (!row) return null;
    row.revokedAt = nowIso();
    return row;
  }
  async rotateOverlayToken(id: string, newHash: string): Promise<OverlayRow | null> {
    const row = this.overlays.get(id);
    if (!row) return null;
    if (row.revokedAt) throw conflict("revoked");
    if (this.overlaysByHash.has(newHash)) throw conflict("overlay exists");
    this.overlaysByHash.delete(row.viewTokenHash);
    row.viewTokenHash = newHash;
    row.rotatedAt = nowIso();
    this.overlaysByHash.set(newHash, row.id);
    return row;
  }
  async recordTrigger(row: Omit<TriggerRow, "id" | "createdAt">): Promise<TriggerRow> {
    const full: TriggerRow = { ...row, id: randomUUID(), createdAt: nowIso() };
    this.triggers.push(full);
    return full;
  }
  async findTriggerByDedup(workspaceId: string, key: string): Promise<TriggerRow | null> {
    for (let i = this.triggers.length - 1; i >= 0; i -= 1) {
      const t = this.triggers[i];
      if (t && t.workspaceId === workspaceId && t.dedupKey === key && t.status === "accepted") return t;
    }
    return null;
  }
  async listTriggers(workspaceId: string, limit: number): Promise<TriggerRow[]> {
    return this.triggers.filter((t) => t.workspaceId === workspaceId).slice(-Math.max(1, limit)).reverse();
  }
  async recordAudit(row: Omit<AuditRow, "id" | "createdAt">): Promise<AuditRow> {
    const full: AuditRow = { ...row, id: randomUUID(), createdAt: nowIso() };
    this.audits.push(full);
    return full;
  }
  async listAudit(workspaceId: string, limit: number): Promise<AuditRow[]> {
    return this.audits.filter((a) => a.workspaceId === workspaceId).slice(-Math.max(1, limit)).reverse();
  }
}

function conflict(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "conflict" });
}

/** Migration file path (Postgres production target). */
export function migrationPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "migrations", "001_init.sql");
}

export async function readMigrationSql(): Promise<string> {
  return readFile(migrationPath(), "utf8");
}

type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

function str(v: unknown): string {
  return String(v ?? "");
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

/**
 * Postgres-backed store. Loads the `pg` driver dynamically so test/dev
 * installs without a database keep working; production sets DATABASE_URL
 * and installs `pg`, then runs migrations from server/migrations/.
 */
export class PostgresStore implements Store {
  private pool: PgPool;
  private constructor(pool: PgPool) {
    this.pool = pool;
  }

  static async connect(databaseUrl: string): Promise<PostgresStore> {
    let mod: unknown;
    try {
      // @ts-ignore - 'pg' is an optional production dependency, absent in test/dev installs
      mod = await import("pg");
    } catch {
      throw new Error("Postgres requested (DATABASE_URL set) but the 'pg' package is not installed. Run: npm install pg");
    }
    const pg = mod as { Pool: new (opts: { connectionString: string }) => PgPool };
    const store = new PostgresStore(new pg.Pool({ connectionString: databaseUrl }));
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    const sql = await readMigrationSql();
    const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(email: string, passwordHash: string, displayName: string): Promise<UserRow> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3)
         RETURNING id::text AS id, email, password_hash AS "passwordHash", display_name AS "displayName",
                   created_at::text AS "createdAt", updated_at::text AS "updatedAt"`,
        [email.trim(), passwordHash, displayName]
      );
      const r = rows[0] as Record<string, unknown>;
      return { id: str(r["id"]), email: str(r["email"]), passwordHash: str(r["passwordHash"]), displayName: str(r["displayName"]), createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) };
    } catch (err) {
      if (/duplicate|unique/i.test((err as Error).message)) throw conflict("email taken");
      throw err;
    }
  }
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, email, password_hash AS "passwordHash", display_name AS "displayName",
              created_at::text AS "createdAt", updated_at::text AS "updatedAt"
       FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email.trim()]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), email: str(r["email"]), passwordHash: str(r["passwordHash"]), displayName: str(r["displayName"]), createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) } : null;
  }
  async findUserById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, email, password_hash AS "passwordHash", display_name AS "displayName",
              created_at::text AS "createdAt", updated_at::text AS "updatedAt"
       FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), email: str(r["email"]), passwordHash: str(r["passwordHash"]), displayName: str(r["displayName"]), createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) } : null;
  }
  async updateUser(id: string, patch: { displayName?: string; passwordHash?: string }): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), password_hash = COALESCE($3, password_hash), updated_at = now()
       WHERE id = $1
       RETURNING id::text AS id, email, password_hash AS "passwordHash", display_name AS "displayName",
                 created_at::text AS "createdAt", updated_at::text AS "updatedAt"`,
      [id, patch.displayName ?? null, patch.passwordHash ?? null]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), email: str(r["email"]), passwordHash: str(r["passwordHash"]), displayName: str(r["displayName"]), createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) } : null;
  }
  async createReset(userId: string, tokenHash: string, expiresAt: number): Promise<ResetRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,to_timestamp($3/1000.0))
       RETURNING id::text AS id, user_id::text AS "userId", token_hash AS "tokenHash",
                 (extract(epoch from expires_at)*1000)::bigint AS "expiresAt",
                 (extract(epoch from created_at)*1000)::bigint AS "createdAt"`,
      [userId, tokenHash, expiresAt]
    );
    const r = rows[0] as Record<string, unknown>;
    return { id: str(r["id"]), userId: str(r["userId"]), tokenHash: str(r["tokenHash"]), expiresAt: num(r["expiresAt"]), usedAt: null, createdAt: num(r["createdAt"]) };
  }
  async findResetByHash(tokenHash: string): Promise<ResetRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, user_id::text AS "userId", token_hash AS "tokenHash",
              (extract(epoch from expires_at)*1000)::bigint AS "expiresAt",
              CASE WHEN used_at IS NULL THEN NULL ELSE (extract(epoch from used_at)*1000)::bigint END AS "usedAt",
              (extract(epoch from created_at)*1000)::bigint AS "createdAt"
       FROM password_resets WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), userId: str(r["userId"]), tokenHash: str(r["tokenHash"]), expiresAt: num(r["expiresAt"]), usedAt: r["usedAt"] == null ? null : num(r["usedAt"]), createdAt: num(r["createdAt"]) } : null;
  }
  async markResetUsed(id: string): Promise<void> {
    await this.pool.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [id]);
  }
  async createSession(userId: string, tokenHash: string, expiresAt: number): Promise<SessionRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,to_timestamp($3/1000.0))
       RETURNING id::text AS id, user_id::text AS "userId", token_hash AS "tokenHash",
                 (extract(epoch from expires_at)*1000)::bigint AS "expiresAt",
                 (extract(epoch from created_at)*1000)::bigint AS "createdAt",
                 (extract(epoch from last_seen_at)*1000)::bigint AS "lastSeenAt"`,
      [userId, tokenHash, expiresAt]
    );
    const r = rows[0] as Record<string, unknown>;
    return { id: str(r["id"]), userId: str(r["userId"]), tokenHash: str(r["tokenHash"]), expiresAt: num(r["expiresAt"]), createdAt: num(r["createdAt"]), lastSeenAt: num(r["lastSeenAt"]) };
  }
  async findSessionByHash(tokenHash: string): Promise<SessionRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, user_id::text AS "userId", token_hash AS "tokenHash",
              (extract(epoch from expires_at)*1000)::bigint AS "expiresAt",
              (extract(epoch from created_at)*1000)::bigint AS "createdAt",
              (extract(epoch from last_seen_at)*1000)::bigint AS "lastSeenAt"
       FROM sessions WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), userId: str(r["userId"]), tokenHash: str(r["tokenHash"]), expiresAt: num(r["expiresAt"]), createdAt: num(r["createdAt"]), lastSeenAt: num(r["lastSeenAt"]) } : null;
  }
  async touchSession(id: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }
  async deleteSessionByHash(tokenHash: string): Promise<boolean> {
    const { rows } = await this.pool.query(`DELETE FROM sessions WHERE token_hash = $1 RETURNING id`, [tokenHash]);
    return rows.length > 0;
  }
  async deleteSessionsForUser(userId: string): Promise<number> {
    const { rows } = await this.pool.query(`DELETE FROM sessions WHERE user_id = $1 RETURNING id`, [userId]);
    return rows.length;
  }
  async createWorkspace(name: string, ownerId: string): Promise<WorkspaceRow> {
    const { rows } = await this.pool.query(
      `WITH w AS (INSERT INTO workspaces (name, owner_id) VALUES ($1,$2)
        RETURNING id::text AS id, name, owner_id::text AS "ownerId", active_pack_uid AS "activePackUid",
                  created_at::text AS "createdAt", updated_at::text AS "updatedAt")
       SELECT * FROM w`,
      [name, ownerId]
    );
    const r = rows[0] as Record<string, unknown>;
    await this.pool.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`, [r["id"], ownerId]);
    return { id: str(r["id"]), name: str(r["name"]), ownerId: str(r["ownerId"]), activePackUid: (r["activePackUid"] as string) ?? null, createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) };
  }
  async findWorkspace(id: string): Promise<WorkspaceRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, name, owner_id::text AS "ownerId", active_pack_uid AS "activePackUid",
              created_at::text AS "createdAt", updated_at::text AS "updatedAt"
       FROM workspaces WHERE id = $1 LIMIT 1`,
      [id]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), name: str(r["name"]), ownerId: str(r["ownerId"]), activePackUid: (r["activePackUid"] as string) ?? null, createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) } : null;
  }
  async listWorkspacesForUser(userId: string): Promise<Array<{ workspace: WorkspaceRow; role: Role }>> {
    const { rows } = await this.pool.query(
      `SELECT w.id::text AS id, w.name, w.owner_id::text AS "ownerId", w.active_pack_uid AS "activePackUid",
              w.created_at::text AS "createdAt", w.updated_at::text AS "updatedAt", m.role AS role
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.created_at`,
      [userId]
    );
    return rows.map((r) => ({
      workspace: { id: str(r["id"]), name: str(r["name"]), ownerId: str(r["ownerId"]), activePackUid: (r["activePackUid"] as string) ?? null, createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) },
      role: str(r["role"]) as Role,
    }));
  }
  async setActivePack(workspaceId: string, packUid: string | null): Promise<WorkspaceRow | null> {
    if (packUid !== null) {
      const { rows } = await this.pool.query(`SELECT id FROM packs WHERE workspace_id = $1 AND pack_uid = $2 LIMIT 1`, [workspaceId, packUid]);
      if (rows.length === 0) throw conflict("no pack");
    }
    const { rows } = await this.pool.query(
      `UPDATE workspaces SET active_pack_uid = $2, updated_at = now() WHERE id = $1
       RETURNING id::text AS id, name, owner_id::text AS "ownerId", active_pack_uid AS "activePackUid",
                 created_at::text AS "createdAt", updated_at::text AS "updatedAt"`,
      [workspaceId, packUid]
    );
    const r = rows[0];
    return r ? { id: str(r["id"]), name: str(r["name"]), ownerId: str(r["ownerId"]), activePackUid: (r["activePackUid"] as string) ?? null, createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]) } : null;
  }
  async addMember(workspaceId: string, userId: string, role: Role): Promise<MembershipRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING workspace_id::text AS "workspaceId", user_id::text AS "userId", role,
                 created_at::text AS "createdAt"`,
      [workspaceId, userId, role]
    );
    const r = rows[0] as Record<string, unknown>;
    return { workspaceId: str(r["workspaceId"]), userId: str(r["userId"]), role: str(r["role"]) as Role, createdAt: str(r["createdAt"]) };
  }
  async findMembership(workspaceId: string, userId: string): Promise<MembershipRow | null> {
    const { rows } = await this.pool.query(
      `SELECT workspace_id::text AS "workspaceId", user_id::text AS "userId", role, created_at::text AS "createdAt"
       FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspaceId, userId]
    );
    const r = rows[0];
    return r ? { workspaceId: str(r["workspaceId"]), userId: str(r["userId"]), role: str(r["role"]) as Role, createdAt: str(r["createdAt"]) } : null;
  }
  async listMembers(workspaceId: string): Promise<MembershipRow[]> {
    const { rows } = await this.pool.query(
      `SELECT workspace_id::text AS "workspaceId", user_id::text AS "userId", role, created_at::text AS "createdAt"
       FROM memberships WHERE workspace_id = $1`,
      [workspaceId]
    );
    return rows.map((r) => ({ workspaceId: str(r["workspaceId"]), userId: str(r["userId"]), role: str(r["role"]) as Role, createdAt: str(r["createdAt"]) }));
  }
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const mem = await this.findMembership(workspaceId, userId);
    if (!mem) return false;
    if (mem.role === "owner") {
      const { rows } = await this.pool.query(`SELECT count(*) AS c FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [workspaceId]);
      if (num((rows[0] as Record<string, unknown>)["c"]) <= 1) throw conflict("last owner");
    }
    await this.pool.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    return true;
  }
  async upsertPack(workspaceId: string, packUid: string, name: string, version: number, data: unknown, createdBy: string | null): Promise<PackRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO packs (workspace_id, pack_uid, name, version, data, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, pack_uid) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", pack_uid AS "packUid", name, version, data,
                 created_by::text AS "createdBy", created_at::text AS "createdAt", updated_at::text AS "updatedAt"`,
      [workspaceId, packUid, name, version, JSON.stringify(data), createdBy]
    );
    const r = rows[0] as Record<string, unknown>;
    return packFrom(r);
  }
  async findPack(workspaceId: string, packUid: string): Promise<PackRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", pack_uid AS "packUid", name, version, data,
              created_by::text AS "createdBy", created_at::text AS "createdAt", updated_at::text AS "updatedAt"
       FROM packs WHERE workspace_id = $1 AND pack_uid = $2 LIMIT 1`,
      [workspaceId, packUid]
    );
    const r = rows[0];
    return r ? packFrom(r) : null;
  }
  async listPacks(workspaceId: string): Promise<PackRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", pack_uid AS "packUid", name, version, data,
              created_by::text AS "createdBy", created_at::text AS "createdAt", updated_at::text AS "updatedAt"
       FROM packs WHERE workspace_id = $1 ORDER BY updated_at DESC`,
      [workspaceId]
    );
    return rows.map(packFrom);
  }
  async deletePack(workspaceId: string, packUid: string): Promise<boolean> {
    await this.pool.query(`UPDATE workspaces SET active_pack_uid = NULL, updated_at = now() WHERE id = $1 AND active_pack_uid = $2`, [workspaceId, packUid]);
    const { rows } = await this.pool.query(`DELETE FROM packs WHERE workspace_id = $1 AND pack_uid = $2 RETURNING id`, [workspaceId, packUid]);
    return rows.length > 0;
  }
  async createMedia(row: Omit<MediaRow, "id" | "createdAt">): Promise<MediaRow> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO media (workspace_id, name, bytes, kind, mime, version, storage_key, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, bytes, kind, mime, version,
                   storage_key AS "storageKey", uploaded_by::text AS "uploadedBy", created_at::text AS "createdAt"`,
        [row.workspaceId, row.name, row.bytes, row.kind, row.mime, row.version, row.storageKey, row.uploadedBy]
      );
      return mediaFrom(rows[0] as Record<string, unknown>);
    } catch (err) {
      if (/duplicate|unique/i.test((err as Error).message)) throw conflict("media exists");
      throw err;
    }
  }
  async updateMediaVersion(workspaceId: string, name: string, bytes: number, mime: string, storageKey: string): Promise<MediaRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE media SET bytes = $3, mime = $4, storage_key = $5, version = version + 1 WHERE workspace_id = $1 AND name = $2
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, bytes, kind, mime, version,
                 storage_key AS "storageKey", uploaded_by::text AS "uploadedBy", created_at::text AS "createdAt"`,
      [workspaceId, name, bytes, mime, storageKey]
    );
    const r = rows[0];
    return r ? mediaFrom(r) : null;
  }
  async findMedia(workspaceId: string, name: string): Promise<MediaRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", name, bytes, kind, mime, version,
              storage_key AS "storageKey", uploaded_by::text AS "uploadedBy", created_at::text AS "createdAt"
       FROM media WHERE workspace_id = $1 AND name = $2 LIMIT 1`,
      [workspaceId, name]
    );
    const r = rows[0];
    return r ? mediaFrom(r) : null;
  }
  async listMedia(workspaceId: string): Promise<MediaRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", name, bytes, kind, mime, version,
              storage_key AS "storageKey", uploaded_by::text AS "uploadedBy", created_at::text AS "createdAt"
       FROM media WHERE workspace_id = $1 ORDER BY name`,
      [workspaceId]
    );
    return rows.map(mediaFrom);
  }
  async deleteMedia(workspaceId: string, name: string): Promise<MediaRow | null> {
    const { rows } = await this.pool.query(
      `DELETE FROM media WHERE workspace_id = $1 AND name = $2
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, bytes, kind, mime, version,
                 storage_key AS "storageKey", uploaded_by::text AS "uploadedBy", created_at::text AS "createdAt"`,
      [workspaceId, name]
    );
    const r = rows[0];
    return r ? mediaFrom(r) : null;
  }
  async workspaceMediaBytes(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COALESCE(sum(bytes),0) AS total FROM media WHERE workspace_id = $1`, [workspaceId]);
    return num((rows[0] as Record<string, unknown>)["total"]);
  }
  async createOverlay(workspaceId: string, name: string, viewTokenHash: string, createdBy: string | null): Promise<OverlayRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO overlay_sessions (workspace_id, name, view_token_hash, created_by) VALUES ($1,$2,$3,$4)
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
                 revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
                 created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"`,
      [workspaceId, name, viewTokenHash, createdBy]
    );
    return overlayFrom(rows[0] as Record<string, unknown>);
  }
  async findOverlayById(id: string): Promise<OverlayRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
              revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
              created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"
       FROM overlay_sessions WHERE id = $1 LIMIT 1`,
      [id]
    );
    const r = rows[0];
    return r ? overlayFrom(r) : null;
  }
  async findOverlayByTokenHash(hash: string): Promise<OverlayRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
              revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
              created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"
       FROM overlay_sessions WHERE view_token_hash = $1 LIMIT 1`,
      [hash]
    );
    const r = rows[0];
    return r ? overlayFrom(r) : null;
  }
  async listOverlays(workspaceId: string): Promise<OverlayRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
              revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
              created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"
       FROM overlay_sessions WHERE workspace_id = $1 ORDER BY created_at`,
      [workspaceId]
    );
    return rows.map(overlayFrom);
  }
  async revokeOverlay(id: string): Promise<OverlayRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE overlay_sessions SET revoked_at = now() WHERE id = $1
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
                 revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
                 created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"`,
      [id]
    );
    const r = rows[0];
    return r ? overlayFrom(r) : null;
  }
  async rotateOverlayToken(id: string, newHash: string): Promise<OverlayRow | null> {
    const current = await this.findOverlayById(id);
    if (!current) return null;
    if (current.revokedAt) throw conflict("revoked");
    const { rows } = await this.pool.query(
      `UPDATE overlay_sessions SET view_token_hash = $2, rotated_at = now() WHERE id = $1
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", name, view_token_hash AS "viewTokenHash",
                 revoked_at::text AS "revokedAt", created_by::text AS "createdBy",
                 created_at::text AS "createdAt", rotated_at::text AS "rotatedAt"`,
      [id, newHash]
    );
    const r = rows[0];
    return r ? overlayFrom(r) : null;
  }
  async recordTrigger(row: Omit<TriggerRow, "id" | "createdAt">): Promise<TriggerRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO trigger_history (workspace_id, effect_uid, moment, template_id, dedup_key, status, delivered, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", effect_uid AS "effectUid", moment,
                 template_id AS "templateId", dedup_key AS "dedupKey", status, delivered,
                 created_by::text AS "createdBy", created_at::text AS "createdAt"`,
      [row.workspaceId, row.effectUid, row.moment, row.templateId, row.dedupKey, row.status, row.delivered, row.createdBy]
    );
    return triggerFrom(rows[0] as Record<string, unknown>);
  }
  async findTriggerByDedup(workspaceId: string, key: string): Promise<TriggerRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", effect_uid AS "effectUid", moment,
              template_id AS "templateId", dedup_key AS "dedupKey", status, delivered,
              created_by::text AS "createdBy", created_at::text AS "createdAt"
       FROM trigger_history WHERE workspace_id = $1 AND dedup_key = $2 AND status = 'accepted'
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, key]
    );
    const r = rows[0];
    return r ? triggerFrom(r) : null;
  }
  async listTriggers(workspaceId: string, limit: number): Promise<TriggerRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", effect_uid AS "effectUid", moment,
              template_id AS "templateId", dedup_key AS "dedupKey", status, delivered,
              created_by::text AS "createdBy", created_at::text AS "createdAt"
       FROM trigger_history WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [workspaceId, Math.max(1, limit)]
    );
    return rows.map(triggerFrom);
  }
  async recordAudit(row: Omit<AuditRow, "id" | "createdAt">): Promise<AuditRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO audit_events (workspace_id, actor_id, action, target, meta) VALUES ($1,$2,$3,$4,$5)
       RETURNING id::text AS id, workspace_id::text AS "workspaceId", actor_id::text AS "actorId",
                 action, target, meta, created_at::text AS "createdAt"`,
      [row.workspaceId, row.actorId, row.action, row.target, JSON.stringify(row.meta)]
    );
    const r = rows[0] as Record<string, unknown>;
    return { id: str(r["id"]), workspaceId: r["workspaceId"] == null ? null : str(r["workspaceId"]), actorId: r["actorId"] == null ? null : str(r["actorId"]), action: str(r["action"]), target: str(r["target"]), meta: (r["meta"] as Record<string, unknown>) ?? {}, createdAt: str(r["createdAt"]) };
  }
  async listAudit(workspaceId: string, limit: number): Promise<AuditRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id, workspace_id::text AS "workspaceId", actor_id::text AS "actorId",
              action, target, meta, created_at::text AS "createdAt"
       FROM audit_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [workspaceId, Math.max(1, limit)]
    );
    return rows.map((r) => ({ id: str(r["id"]), workspaceId: str(r["workspaceId"]), actorId: r["actorId"] == null ? null : str(r["actorId"]), action: str(r["action"]), target: str(r["target"]), meta: (r["meta"] as Record<string, unknown>) ?? {}, createdAt: str(r["createdAt"]) }));
  }
}

function packFrom(r: Record<string, unknown>): PackRow {
  const raw = r["data"];
  return {
    id: str(r["id"]), workspaceId: str(r["workspaceId"]), packUid: str(r["packUid"]), name: str(r["name"]),
    version: num(r["version"]), data: typeof raw === "string" ? JSON.parse(raw) : raw,
    createdBy: r["createdBy"] == null ? null : str(r["createdBy"]), createdAt: str(r["createdAt"]), updatedAt: str(r["updatedAt"]),
  };
}

function mediaFrom(r: Record<string, unknown>): MediaRow {
  return {
    id: str(r["id"]), workspaceId: str(r["workspaceId"]), name: str(r["name"]), bytes: num(r["bytes"]),
    kind: str(r["kind"]) as MediaRow["kind"], mime: str(r["mime"]), version: num(r["version"]),
    storageKey: str(r["storageKey"]), uploadedBy: r["uploadedBy"] == null ? null : str(r["uploadedBy"]), createdAt: str(r["createdAt"]),
  };
}

function overlayFrom(r: Record<string, unknown>): OverlayRow {
  return {
    id: str(r["id"]), workspaceId: str(r["workspaceId"]), name: str(r["name"]), viewTokenHash: str(r["viewTokenHash"]),
    revokedAt: r["revokedAt"] == null ? null : str(r["revokedAt"]), createdBy: r["createdBy"] == null ? null : str(r["createdBy"]),
    createdAt: str(r["createdAt"]), rotatedAt: r["rotatedAt"] == null ? null : str(r["rotatedAt"]),
  };
}

function triggerFrom(r: Record<string, unknown>): TriggerRow {
  return {
    id: str(r["id"]), workspaceId: str(r["workspaceId"]), effectUid: r["effectUid"] == null ? null : str(r["effectUid"]),
    moment: str(r["moment"]), templateId: r["templateId"] == null ? null : str(r["templateId"]),
    dedupKey: r["dedupKey"] == null ? null : str(r["dedupKey"]),
    status: str(r["status"]) as TriggerRow["status"], delivered: num(r["delivered"]),
    createdBy: r["createdBy"] == null ? null : str(r["createdBy"]), createdAt: str(r["createdAt"]),
  };
}

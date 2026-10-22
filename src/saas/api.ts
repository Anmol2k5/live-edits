import { isTauri } from "@tauri-apps/api/core";

export class SaasError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SaasError";
  }
}

/**
 * Authentication modes. Web browsers use HttpOnly cookies (+ CSRF) and
 * never persist tokens; the desktop companion (Tauri) uses Bearer tokens
 * kept out of cookies entirely. The two paths are separate by construction:
 * cookie-authenticated writes require CSRF, Bearer writes are exempt.
 */
export type SaasAuthMode = "web" | "desktop";

const TOKEN_KEY = "live-edits.saas.token";
const BASE_KEY = "live-edits.saas.base";
const WORKSPACE_KEY = "live-edits.saas.workspace";
const MODE_KEY = "live-edits.saas.auth-mode";
export const DEFAULT_SAAS_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:4290"
    : "http://127.0.0.1:4290";

export function getAuthMode(): SaasAuthMode {
  try {
    const forced = localStorage.getItem(MODE_KEY);
    if (forced === "desktop" || forced === "web") return forced;
  } catch {
    // ignore storage failures
  }
  return isTauri() ? "desktop" : "web";
}

export function setAuthMode(mode: SaasAuthMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

function readCsrfCookie(): string {
  try {
    for (const part of document.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === "le_csrf") {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  } catch {
    // ignore
  }
  return "";
}

export function loadSaasBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) || DEFAULT_SAAS_BASE;
  } catch {
    return DEFAULT_SAAS_BASE;
  }
}

export function saveSaasBase(base: string): void {
  try {
    localStorage.setItem(BASE_KEY, base);
  } catch {
    // ignore
  }
}

export function loadSaasToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSaasToken(token: string): void {
  // Desktop-only persistence: the Tauri companion keeps its Bearer token in
  // OS secure storage; this localStorage entry is the browser stand-in used
  // by e2e. Web mode never calls this (HttpOnly cookie instead).
  if (getAuthMode() !== "desktop") return;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function loadSaasWorkspace(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSaasWorkspace(id: string): void {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // ignore
  }
}

function baseOf(base: string): string {
  return base.replace(/\/+$/, "");
}

async function request(base: string, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const desktop = getAuthMode() === "desktop";
  const csrf = desktop ? "" : readCsrfCookie();
  const response = await fetch(`${baseOf(base)}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(desktop && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(!desktop && csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = (parsed as { error?: string } | null)?.error || `Request failed (${response.status})`;
    throw new SaasError(message, response.status);
  }
  return parsed;
}

export const saasApi = {
  register: (base: string, email: string, password: string, displayName = ""): Promise<{ user: { id: string; email: string }; token: string }> =>
    request(base, "", "POST", "/api/auth/register", { email, password, displayName }) as Promise<{ user: { id: string; email: string }; token: string }>,
  login: (base: string, email: string, password: string): Promise<{ user: { id: string; email: string }; token: string }> =>
    request(base, "", "POST", "/api/auth/login", { email, password }) as Promise<{ user: { id: string; email: string }; token: string }>,
  logout: (base: string, token: string): Promise<void> => {
    return request(base, token, "POST", "/api/auth/logout").then(() => undefined);
  },
  me: (base: string, token: string): Promise<{ user: { id: string; email: string; displayName: string } }> =>
    request(base, token, "GET", "/api/auth/me") as Promise<{ user: { id: string; email: string; displayName: string } }>,
  recoverRequest: (base: string, email: string): Promise<{ ok: boolean; resetToken?: string }> =>
    request(base, "", "POST", "/api/auth/recover/request", { email }) as Promise<{ ok: boolean; resetToken?: string }>,
  recoverConfirm: (base: string, token: string, newPassword: string): Promise<void> => {
    return request(base, "", "POST", "/api/auth/recover/confirm", { token, newPassword }).then(() => undefined);
  },
  patchAccount: (base: string, token: string, patch: { displayName?: string; currentPassword?: string; newPassword?: string }): Promise<{ user: { displayName: string }; token?: string }> =>
    request(base, token, "PATCH", "/api/auth/account", patch) as Promise<{ user: { displayName: string }; token?: string }>,
  listSessions: (base: string, token: string): Promise<{ sessions: Array<{ id: string; current: boolean; createdAt: number; lastSeenAt: number }> }> =>
    request(base, token, "GET", "/api/auth/sessions") as Promise<{ sessions: Array<{ id: string; current: boolean; createdAt: number; lastSeenAt: number }> }>,
  revokeOtherSessions: (base: string, token: string): Promise<void> => {
    return request(base, token, "DELETE", "/api/auth/sessions").then(() => undefined);
  },

  createWorkspace: (base: string, token: string, name: string): Promise<{ workspace: { id: string; name: string } }> =>
    request(base, token, "POST", "/api/workspaces", { name }) as Promise<{ workspace: { id: string; name: string } }>,
  listWorkspaces: (base: string, token: string): Promise<{ workspaces: Array<{ id: string; name: string; role: string; activePackUid: string | null }> }> =>
    request(base, token, "GET", "/api/workspaces") as Promise<{ workspaces: Array<{ id: string; name: string; role: string; activePackUid: string | null }> }>,
  listMembers: (base: string, token: string, ws: string): Promise<{ members: Array<{ userId: string; email: string; role: string }> }> =>
    request(base, token, "GET", `/api/workspaces/${encodeURIComponent(ws)}/members`) as Promise<{ members: Array<{ userId: string; email: string; role: string }> }>,
  addMember: (base: string, token: string, ws: string, email: string, role: string): Promise<void> => {
    return request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/members`, { email, role }).then(() => undefined);
  },

  listPacks: (base: string, token: string, ws: string): Promise<{ packs: Array<{ packUid: string; name: string; version: number }> }> =>
    request(base, token, "GET", `/api/workspaces/${encodeURIComponent(ws)}/packs`) as Promise<{ packs: Array<{ packUid: string; name: string; version: number }> }>,
  getPack: (base: string, token: string, ws: string, uid: string): Promise<{ pack: { packUid: string; name: string; version: number; data: unknown } }> =>
    request(base, token, "GET", `/api/workspaces/${encodeURIComponent(ws)}/packs/${encodeURIComponent(uid)}`) as Promise<{ pack: { packUid: string; name: string; version: number; data: unknown } }>,
  savePack: (base: string, token: string, ws: string, data: unknown): Promise<void> => {
    return request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/packs`, data).then(() => undefined);
  },
  deletePack: (base: string, token: string, ws: string, uid: string): Promise<void> => {
    return request(base, token, "DELETE", `/api/workspaces/${encodeURIComponent(ws)}/packs/${encodeURIComponent(uid)}`).then(() => undefined);
  },
  activatePack: (base: string, token: string, ws: string, packUid: string | null): Promise<void> => {
    return request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/activate`, { packUid }).then(() => undefined);
  },

  listMedia: (base: string, token: string, ws: string): Promise<{ media: Array<{ name: string; bytes: number; kind: string; version: number }> }> =>
    request(base, token, "GET", `/api/workspaces/${encodeURIComponent(ws)}/media`) as Promise<{ media: Array<{ name: string; bytes: number; kind: string; version: number }> }>,
  uploadMedia: async (base: string, token: string, ws: string, file: File): Promise<{ name: string }> => {
    const desktop = getAuthMode() === "desktop";
    const csrf = desktop ? "" : readCsrfCookie();
    const response = await fetch(`${baseOf(base)}/api/workspaces/${encodeURIComponent(ws)}/media`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...(desktop && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(!desktop && csrf ? { "X-CSRF-Token": csrf } : {}),
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (response.status === 201) return (await response.json()) as { name: string };
    let code = `HTTP ${response.status}`;
    try {
      code = ((await response.json()) as { error?: string }).error || code;
    } catch {
      // keep status text
    }
    throw new SaasError(code, response.status);
  },
  deleteMedia: (base: string, token: string, ws: string, name: string): Promise<void> => {
    return request(base, token, "DELETE", `/api/workspaces/${encodeURIComponent(ws)}/media/${encodeURIComponent(name)}`).then(() => undefined);
  },

  listOverlays: (base: string, token: string, ws: string): Promise<{ overlays: Array<{ id: string; name: string; revoked: boolean }> }> =>
    request(base, token, "GET", `/api/workspaces/${encodeURIComponent(ws)}/overlays`) as Promise<{ overlays: Array<{ id: string; name: string; revoked: boolean }> }>,
  createOverlay: (base: string, token: string, ws: string, name: string): Promise<{ overlay: { id: string; name: string }; viewToken: string }> =>
    request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/overlays`, { name }) as Promise<{ overlay: { id: string; name: string }; viewToken: string }>,
  revokeOverlay: (base: string, token: string, ws: string, id: string): Promise<void> => {
    return request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/overlays/${encodeURIComponent(id)}/revoke`).then(() => undefined);
  },
  rotateOverlay: (base: string, token: string, ws: string, id: string): Promise<{ viewToken: string }> =>
    request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/overlays/${encodeURIComponent(id)}/rotate`) as Promise<{ viewToken: string }>,

  fire: (base: string, token: string, ws: string, body: Record<string, unknown>): Promise<{ accepted: boolean; duplicate?: boolean; connectedOverlays?: number }> =>
    request(base, token, "POST", `/api/workspaces/${encodeURIComponent(ws)}/trigger`, body) as Promise<{ accepted: boolean; duplicate?: boolean; connectedOverlays?: number }>,
};

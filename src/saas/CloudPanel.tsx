import { useCallback, useEffect, useRef, useState } from "react";
import {
  saasApi,
  SaasError,
  getAuthMode,
  loadSaasBase,
  saveSaasBase,
  loadSaasToken,
  saveSaasToken,
  loadSaasWorkspace,
  saveSaasWorkspace,
} from "./api";
import { validateMediaFile } from "../editor/mediaLibrary";
import type { PackLibrary } from "../packs/packStore";
import type { ReactionPack } from "../packs/packSchemas";

interface CloudPanelProps {
  library: PackLibrary;
  onLibraryChange: (library: PackLibrary) => void;
  onLoadCloudPack: (data: unknown) => { ok: boolean; message: string };
}

interface CloudPackMeta {
  packUid: string;
  name: string;
  version: number;
}

interface CloudMediaItem {
  name: string;
  bytes: number;
  kind: string;
  version: number;
}

interface CloudOverlay {
  id: string;
  name: string;
  revoked: boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CloudPanel(props: CloudPanelProps): React.JSX.Element {
  const { library, onLoadCloudPack } = props;
  const [base, setBase] = useState(() => loadSaasBase());
  // Desktop (Tauri) sessions persist a Bearer token as the secure-store
  // stand-in; web sessions live in the HttpOnly cookie and start empty.
  const [token, setToken] = useState(() => (getAuthMode() === "desktop" ? loadSaasToken() : ""));
  const [userEmail, setUserEmail] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authNote, setAuthNote] = useState<string | null>(null);
  const [recoverEmail, setRecoverEmail] = useState("");
  const [recoverToken, setRecoverToken] = useState("");
  const [recoverPassword, setRecoverPassword] = useState("");
  const [recoverNote, setRecoverNote] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; current: boolean }>>([]);
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; role: string; activePackUid: string | null }>>([]);
  const [workspaceId, setWorkspaceId] = useState(() => loadSaasWorkspace());
  const [newWorkspace, setNewWorkspace] = useState("");
  const [wsNote, setWsNote] = useState<string | null>(null);
  const [packs, setPacks] = useState<CloudPackMeta[]>([]);
  const [newPackName, setNewPackName] = useState("");
  const [packNote, setPackNote] = useState<string | null>(null);
  const [media, setMedia] = useState<CloudMediaItem[]>([]);
  const [mediaNote, setMediaNote] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<CloudOverlay[]>([]);
  const [overlayTokens, setOverlayTokens] = useState<Record<string, string>>({});
  const [newOverlay, setNewOverlay] = useState("");
  const [overlayNote, setOverlayNote] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [firePackUid, setFirePackUid] = useState("");
  const [fireEffects, setFireEffects] = useState<Array<{ id: string; name: string; moment: string }>>([]);
  const [fireEffectId, setFireEffectId] = useState("");
  const [fireNote, setFireNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionGeneration = useRef(0);
  const loadGeneration = useRef(0);

  const authed = token.trim().length > 0;
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;

  const clearSession = useCallback(() => {
    sessionGeneration.current++;
    loadGeneration.current++;
    setToken("");
    saveSaasToken("");
    setUserEmail("");
    setWorkspaces([]);
    setWorkspaceId("");
    setPacks([]);
    setMedia([]);
    setOverlays([]);
    setOverlayTokens({});
    setSessions([]);
    setFirePackUid("");
    setFireEffects([]);
    setFireEffectId("");
    setCopiedUrl(null);
  }, []);

  useEffect(() => {
    saveSaasBase(base);
  }, [base]);
  useEffect(() => {
    saveSaasToken(token);
  }, [token]);
  useEffect(() => {
    saveSaasWorkspace(workspaceId);
  }, [workspaceId]);

  // Web sessions survive reload in an HttpOnly cookie, not localStorage.
  // Invalidate stale restoration when the endpoint changes or the user signs in/out.
  useEffect(() => {
    if (getAuthMode() !== "web") return;
    const generation = ++sessionGeneration.current;
    let cancelled = false;
    void saasApi.me(base, "").then(({ user }) => {
      if (cancelled || generation !== sessionGeneration.current) return;
      setToken("cookie-session");
      setUserEmail(user.email);
    }).catch(() => {
      // A missing session or offline backend leaves local workflows available.
    });
    return () => { cancelled = true; };
  }, [base]);

  const loadAll = useCallback(async () => {
    if (!token.trim()) return;
    const generation = ++loadGeneration.current;
    const session = sessionGeneration.current;
    const stale = () => generation !== loadGeneration.current || session !== sessionGeneration.current;
    try {
      const wsList = await saasApi.listWorkspaces(base, token);
      if (stale()) return;
      setWorkspaces(wsList.workspaces);
      if (!workspaceId || !wsList.workspaces.some((w) => w.id === workspaceId)) {
        setPacks([]);
        setMedia([]);
        setOverlays([]);
        if (workspaceId) setWorkspaceId("");
        return;
      }
      const [packList, mediaList, overlayList] = await Promise.all([
        saasApi.listPacks(base, token, workspaceId),
        saasApi.listMedia(base, token, workspaceId),
        saasApi.listOverlays(base, token, workspaceId),
      ]);
      if (stale()) return;
      setPacks(packList.packs);
      setMedia(mediaList.media);
      setOverlays(overlayList.overlays);
    } catch (err) {
      if (!stale()) setWsNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  useEffect(() => {
    if (authed) void loadAll();
    return () => { loadGeneration.current++; };
  }, [authed, loadAll]);

  const handleRegister = useCallback(async () => {
    const generation = ++sessionGeneration.current;
    setAuthNote(null);
    try {
      const res = await saasApi.register(base, email.trim(), password);
      if (generation !== sessionGeneration.current) return;
      setToken(getAuthMode() === "desktop" ? res.token : "cookie-session");
      setUserEmail(email.trim());
      setAuthNote("Registered and signed in.");
    } catch (err) {
      if (generation === sessionGeneration.current) setAuthNote(messageOf(err));
    }
  }, [base, email, password]);

  const handleLogin = useCallback(async () => {
    const generation = ++sessionGeneration.current;
    setAuthNote(null);
    try {
      const res = await saasApi.login(base, email.trim(), password);
      if (generation !== sessionGeneration.current) return;
      setToken(getAuthMode() === "desktop" ? res.token : "cookie-session");
      setUserEmail(email.trim());
      setAuthNote("Signed in.");
    } catch (err) {
      if (generation === sessionGeneration.current) setAuthNote(messageOf(err));
    }
  }, [base, email, password]);

  const handleLogout = useCallback(async () => {
    const generation = ++sessionGeneration.current;
    try {
      await saasApi.logout(base, token);
    } catch {
      // Session may already be gone; still clear locally.
    }
    if (generation !== sessionGeneration.current) return;
    clearSession();
    setAuthNote("Signed out.");
  }, [base, token, clearSession]);

  const handleRecoverRequest = useCallback(async () => {
    setRecoverNote(null);
    try {
      await saasApi.recoverRequest(base, recoverEmail.trim());
      setRecoverNote("If that address has an account, a reset link is on its way.");
    } catch (err) {
      setRecoverNote(messageOf(err));
    }
  }, [base, recoverEmail]);

  const handleRecoverConfirm = useCallback(async () => {
    setRecoverNote(null);
    try {
      await saasApi.recoverConfirm(base, recoverToken.trim(), recoverPassword);
      setRecoverToken("");
      setRecoverPassword("");
      setRecoverNote("Password reset — sign in with the new password.");
    } catch (err) {
      setRecoverNote(messageOf(err));
    }
  }, [base, recoverToken, recoverPassword]);

  const handleRefreshSessions = useCallback(async () => {
    setSessionNote(null);
    try {
      const res = await saasApi.listSessions(base, token);
      setSessions(res.sessions);
    } catch (err) {
      setSessionNote(messageOf(err));
    }
  }, [base, token]);

  const handleRevokeOthers = useCallback(async () => {
    setSessionNote(null);
    try {
      await saasApi.revokeOtherSessions(base, token);
      const res = await saasApi.listSessions(base, token);
      setSessions(res.sessions);
      setSessionNote("Other sessions signed out.");
    } catch (err) {
      setSessionNote(messageOf(err));
    }
  }, [base, token]);

  const handleCreateWorkspace = useCallback(async () => {
    setWsNote(null);
    try {
      const res = await saasApi.createWorkspace(base, token, newWorkspace.trim());
      setNewWorkspace("");
      const list = await saasApi.listWorkspaces(base, token);
      setWorkspaces(list.workspaces);
      setWorkspaceId(res.workspace.id);
      setWsNote(`Workspace "${res.workspace.name}" created.`);
    } catch (err) {
      setWsNote(messageOf(err));
    }
  }, [base, token, newWorkspace]);

  const handleCreatePack = useCallback(async () => {
    setPackNote(null);
    if (!workspaceId) {
      setPackNote("Select a workspace first.");
      return;
    }
    try {
      const id = `pack-${crypto.randomUUID()}`;
      await saasApi.savePack(base, token, workspaceId, { version: 1, id, name: newPackName.trim(), effects: [], assignments: [], sequence: [] });
      setNewPackName("");
      const list = await saasApi.listPacks(base, token, workspaceId);
      setPacks(list.packs);
      setPackNote("Cloud pack created.");
    } catch (err) {
      setPackNote(messageOf(err));
    }
  }, [base, token, workspaceId, newPackName]);

  const handleSaveLocalToCloud = useCallback(async (pack: ReactionPack) => {
    setPackNote(null);
    if (!workspaceId) {
      setPackNote("Select a workspace first.");
      return;
    }
    try {
      await saasApi.savePack(base, token, workspaceId, JSON.parse(JSON.stringify(pack)) as unknown);
      const list = await saasApi.listPacks(base, token, workspaceId);
      setPacks(list.packs);
      setPackNote(`Saved "${pack.name}" to the workspace.`);
    } catch (err) {
      setPackNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleLoadIntoEditor = useCallback(async (uid: string) => {
    setPackNote(null);
    if (!workspaceId) return;
    try {
      const res = await saasApi.getPack(base, token, workspaceId, uid);
      const result = onLoadCloudPack(res.pack.data);
      setPackNote(result.message);
    } catch (err) {
      setPackNote(messageOf(err));
    }
  }, [base, token, workspaceId, onLoadCloudPack]);

  const handleActivate = useCallback(async (uid: string) => {
    setPackNote(null);
    try {
      await saasApi.activatePack(base, token, workspaceId, uid);
      const list = await saasApi.listWorkspaces(base, token);
      setWorkspaces(list.workspaces);
      setPackNote("Workspace pack activated.");
    } catch (err) {
      setPackNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleUploadFiles = useCallback(async (files: FileList | null) => {
    setMediaNote(null);
    if (!files || !workspaceId) return;
    try {
      for (const file of Array.from(files)) {
        const validation = validateMediaFile({ name: file.name, size: file.size, type: file.type });
        if (!validation.ok) {
          setMediaNote(`${file.name}: ${validation.reason}`);
          continue;
        }
        await saasApi.uploadMedia(base, token, workspaceId, file);
      }
      const list = await saasApi.listMedia(base, token, workspaceId);
      setMedia(list.media);
    } catch (err) {
      setMediaNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleDeleteMedia = useCallback(async (name: string) => {
    setMediaNote(null);
    try {
      await saasApi.deleteMedia(base, token, workspaceId, name);
      const list = await saasApi.listMedia(base, token, workspaceId);
      setMedia(list.media);
    } catch (err) {
      setMediaNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleCreateOverlay = useCallback(async () => {
    setOverlayNote(null);
    try {
      const res = await saasApi.createOverlay(base, token, workspaceId, newOverlay.trim() || "OBS Overlay");
      setOverlayTokens((prev) => ({ ...prev, [res.overlay.id]: res.viewToken }));
      setNewOverlay("");
      const list = await saasApi.listOverlays(base, token, workspaceId);
      setOverlays(list.overlays);
      setOverlayNote("Overlay session created — copy its OBS URL now (token shown once).");
    } catch (err) {
      setOverlayNote(messageOf(err));
    }
  }, [base, token, workspaceId, newOverlay]);

  const overlayUrlFor = useCallback((id: string): string | null => {
    const viewToken = overlayTokens[id];
    if (!viewToken) return null;
    return `${base.replace(/\/+$/, "")}/o/${id}?token=${viewToken}`;
  }, [base, overlayTokens]);

  const handleCopyUrl = useCallback(async (id: string) => {
    const url = overlayUrlFor(id);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl("Copied — paste into OBS as a Browser Source URL.");
    } catch {
      setCopiedUrl(url);
    }
  }, [overlayUrlFor]);

  const handleRevoke = useCallback(async (id: string) => {
    setOverlayNote(null);
    try {
      await saasApi.revokeOverlay(base, token, workspaceId, id);
      setOverlayTokens((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      const list = await saasApi.listOverlays(base, token, workspaceId);
      setOverlays(list.overlays);
    } catch (err) {
      setOverlayNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleRotate = useCallback(async (id: string) => {
    setOverlayNote(null);
    try {
      const res = await saasApi.rotateOverlay(base, token, workspaceId, id);
      setOverlayTokens((prev) => ({ ...prev, [id]: res.viewToken }));
      setOverlayNote("Overlay token rotated — old URLs stop working immediately.");
    } catch (err) {
      setOverlayNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handlePickFirePack = useCallback(async (uid: string) => {
    setFirePackUid(uid);
    setFireEffectId("");
    if (!uid) {
      setFireEffects([]);
      return;
    }
    try {
      const res = await saasApi.getPack(base, token, workspaceId, uid);
      const effects = ((res.pack.data as { effects?: Array<{ id: string; name: string; moment: string }> }).effects ?? []).map((e) => ({ id: e.id, name: e.name, moment: e.moment }));
      setFireEffects(effects);
    } catch (err) {
      setFireNote(messageOf(err));
    }
  }, [base, token, workspaceId]);

  const handleFire = useCallback(async () => {
    setFireNote(null);
    if (!fireEffectId) {
      setFireNote("Pick an effect first.");
      return;
    }
    try {
      const effect = fireEffects.find((e) => e.id === fireEffectId);
      const moment = effect?.moment ?? "wow";
      const res = await saasApi.fire(base, token, workspaceId, { moment, templateId: `${moment}-1`, effectId: fireEffectId });
      setFireNote(res.accepted ? `Reaction sent to ${res.connectedOverlays ?? 0} hosted overlay(s).` : "Duplicate ignored.");
    } catch (err) {
      setFireNote(messageOf(err));
    }
  }, [base, token, workspaceId, fireEffectId]);

  return (
    <div className="cloud">
      <section className="editor-panel" aria-label="Hosted backend">
        <h2>Hosted backend</h2>
        <label>
          Backend base URL
          <input aria-label="Cloud backend URL" value={base} onChange={(e) => {
            clearSession();
            setAuthNote(null);
            setBase(e.target.value);
          }} placeholder="http://127.0.0.1:4290" inputMode="url" />
        </label>
        <p className="editor-hint">Local mode (Live/Editor + loopback relay) keeps working with no backend. Cloud features need the backend from `npm run saas`.</p>
      </section>

      <section className="editor-panel" aria-label="Cloud account">
        <h2>Account</h2>
        {authed ? (
          <>
            <p className="editor-hint">Signed in{userEmail ? ` as ${userEmail}` : ""}. Sessions expire after 7 days; sign in again afterwards.</p>
            <div className="editor-row">
              <button type="button" onClick={() => void handleLogout()}>Sign out</button>
              <button type="button" onClick={() => void handleRefreshSessions()}>List sessions</button>
              <button type="button" onClick={() => void handleRevokeOthers()}>Sign out other devices</button>
            </div>
            {sessions.length > 0 && (
              <p className="editor-hint">{sessions.length} active session{sessions.length === 1 ? "" : "s"} (this device marked current).</p>
            )}
            {sessionNote && <p className="editor-status" role="status">{sessionNote}</p>}
          </>
        ) : (
          <>
            <label>
              Email
              <input aria-label="Cloud email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            </label>
            <label>
              Password (10+ characters)
              <input aria-label="Cloud password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <div className="editor-row">
              <button type="button" onClick={() => void handleLogin()}>Sign in</button>
              <button type="button" onClick={() => void handleRegister()}>Register</button>
            </div>
            <details>
              <summary>Forgot password?</summary>
              <label>
                Account email
                <input aria-label="Recovery email" value={recoverEmail} onChange={(e) => setRecoverEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              </label>
              <div className="editor-row">
                <button type="button" onClick={() => void handleRecoverRequest()} disabled={!recoverEmail.trim()}>Send reset link</button>
              </div>
              <label>
                Reset token (from email)
                <input aria-label="Recovery token" value={recoverToken} onChange={(e) => setRecoverToken(e.target.value)} placeholder="Paste the emailed token" />
              </label>
              <label>
                New password (10+ characters)
                <input aria-label="Recovery new password" type="password" value={recoverPassword} onChange={(e) => setRecoverPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <div className="editor-row">
                <button type="button" onClick={() => void handleRecoverConfirm()} disabled={!recoverToken.trim() || !recoverPassword}>Reset password</button>
              </div>
            </details>
          </>
        )}
        {authNote && <p className="editor-status" role="status">{authNote}</p>}
        {recoverNote && <p className="editor-status" role="status">{recoverNote}</p>}
        <p className="editor-hint">Web sign-in uses an HttpOnly cookie (+ CSRF); the desktop companion uses a separate Bearer token.</p>
      </section>

      {authed && (
        <section className="editor-panel" aria-label="Cloud workspaces">
          <h2>Workspaces</h2>
          <label>
            Workspace
            <select aria-label="Cloud workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">Choose a workspace</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.role})</option>
              ))}
            </select>
          </label>
          <div className="editor-row">
            <input aria-label="New workspace name" value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)} placeholder="New workspace name" />
            <button type="button" onClick={() => void handleCreateWorkspace()} disabled={!newWorkspace.trim()}>Create workspace</button>
          </div>
          {activeWorkspace?.activePackUid && <p className="editor-hint">Active cloud pack: {activeWorkspace.activePackUid}</p>}
          {wsNote && <p className="editor-status" role="status">{wsNote}</p>}
        </section>
      )}

      {authed && workspaceId && (
        <>
          <section className="editor-panel" aria-label="Cloud reaction packs">
            <h2>Cloud reaction packs</h2>
            <div className="editor-row">
              <input aria-label="New cloud pack name" value={newPackName} onChange={(e) => setNewPackName(e.target.value)} placeholder="New cloud pack name" />
              <button type="button" onClick={() => void handleCreatePack()} disabled={!newPackName.trim()}>Create cloud pack</button>
            </div>
            <h3>Local packs → cloud</h3>
            {library.packs.length === 0 ? (
              <p className="editor-empty">No local packs yet — build one in the Editor first.</p>
            ) : (
              <ul>
                {library.packs.map((p) => (
                  <li key={p.id}>
                    <span>{p.name} ({p.effects.length} effects)</span>{" "}
                    <button type="button" onClick={() => void handleSaveLocalToCloud(p)}>Save to cloud</button>
                  </li>
                ))}
              </ul>
            )}
            <h3>Cloud packs</h3>
            {packs.length === 0 ? (
              <p className="editor-empty">No cloud packs yet.</p>
            ) : (
              <ul>
                {packs.map((p) => (
                  <li key={p.packUid}>
                    <span>{p.name}</span>{" "}
                    <button type="button" onClick={() => void handleLoadIntoEditor(p.packUid)}>Load into editor</button>{" "}
                    <button type="button" onClick={() => void handleActivate(p.packUid)}>Activate</button>
                  </li>
                ))}
              </ul>
            )}
            {packNote && <p className="editor-status" role="status">{packNote}</p>}
          </section>

          <section className="editor-panel" aria-label="Cloud media">
            <h2>Cloud media</h2>
            <div className="editor-row">
              <button type="button" onClick={() => fileRef.current?.click()}>Upload cloud media</button>
              <input ref={fileRef} type="file" hidden multiple accept="image/*,video/*,audio/*" aria-label="Upload cloud media files" onChange={(e) => {
                void handleUploadFiles(e.target.files);
                e.target.value = "";
              }} />
              <span className="editor-hint">Private per-workspace storage, 50 MB max, content-validated.</span>
            </div>
            {media.length === 0 ? (
              <p className="editor-empty">No cloud media yet.</p>
            ) : (
              <ul>
                {media.map((m) => (
                  <li key={m.name}>
                    <span>{m.kind} · {m.name} · {(m.bytes / 1024).toFixed(1)} KB · v{m.version}</span>{" "}
                    <button type="button" onClick={() => void handleDeleteMedia(m.name)}>Delete cloud media</button>
                  </li>
                ))}
              </ul>
            )}
            {mediaNote && <p className="editor-error" role="alert">{mediaNote}</p>}
          </section>

          <section className="editor-panel" aria-label="Hosted overlays">
            <h2>Hosted overlays</h2>
            <div className="editor-row">
              <input aria-label="New overlay name" value={newOverlay} onChange={(e) => setNewOverlay(e.target.value)} placeholder="OBS Overlay" />
              <button type="button" onClick={() => void handleCreateOverlay()}>Create overlay</button>
            </div>
            {overlays.length === 0 ? (
              <p className="editor-empty">No overlay sessions yet.</p>
            ) : (
              <ul>
                {overlays.map((o) => (
                  <li key={o.id}>
                    <span>{o.name}{o.revoked ? " (revoked)" : ""}</span>{" "}
                    {!o.revoked && overlayUrlFor(o.id) && <button type="button" onClick={() => void handleCopyUrl(o.id)}>Copy hosted OBS URL</button>}{" "}
                    {!o.revoked && <button type="button" onClick={() => void handleRotate(o.id)}>Rotate</button>}{" "}
                    {!o.revoked && <button type="button" onClick={() => void handleRevoke(o.id)}>Revoke</button>}
                    {!o.revoked && overlayUrlFor(o.id) && <div className="editor-hint" data-testid={`hosted-url-${o.id}`}>{overlayUrlFor(o.id)}</div>}
                  </li>
                ))}
              </ul>
            )}
            {overlayNote && <p className="editor-status" role="status">{overlayNote}</p>}
            {copiedUrl && <p className="editor-status" role="status">{copiedUrl}</p>}
          </section>

          <section className="editor-panel" aria-label="Fire hosted effect">
            <h2>Fire hosted effect</h2>
            <label>
              Cloud pack
              <select aria-label="Cloud effect pack" value={firePackUid} onChange={(e) => void handlePickFirePack(e.target.value)}>
                <option value="">Choose a cloud pack</option>
                {packs.map((p) => (
                  <option key={p.packUid} value={p.packUid}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              Effect
              <select aria-label="Cloud effect" value={fireEffectId} onChange={(e) => setFireEffectId(e.target.value)} disabled={fireEffects.length === 0}>
                <option value="">Choose an effect</option>
                {fireEffects.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <div className="editor-row">
              <button type="button" onClick={() => void handleFire()} disabled={!fireEffectId}>Fire cloud effect</button>
            </div>
            {fireNote && <p className="editor-status" role="status">{fireNote}</p>}
          </section>
        </>
      )}
    </div>
  );
}

export function saasErrorMessage(err: unknown): string {
  return err instanceof SaasError ? `${err.message} (${err.status})` : messageOf(err);
}

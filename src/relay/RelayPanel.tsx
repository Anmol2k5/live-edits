import { useCallback, useEffect, useRef, useState } from "react";

const RELAY_BASE = "http://127.0.0.1:4190";

export interface MediaItem {
  name: string;
  bytes: number;
  kind: "video" | "audio" | "image";
}

interface RelayPanelProps {
  relayToken: string;
  setRelayToken: (token: string) => void;
  mediaFile: string;
  setMediaFile: (file: string) => void;
  volume: string;
  setVolume: (volume: string) => void;
  durationMs: string;
  setDurationMs: (duration: string) => void;
  relayStatus: string;
  cameraActive: boolean;
  onTestReaction: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Totally honest autoplay probe: reports what THIS webview can do, which is
 * the same Chromium autoplay policy family OBS uses for Browser Sources.
 */
export async function probeAudioPlayback(): Promise<
  "running" | "suspended" | "blocked"
> {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return "blocked";
    const ctx = new Ctor();
    try {
      await ctx.resume();
    } catch {
      // Ignore; state below tells the story.
    }
    const state = ctx.state;
    try {
      await ctx.close();
    } catch {
      // Ignore close failures.
    }
    return state === "running" ? "running" : "suspended";
  } catch {
    return "blocked";
  }
}

/**
 * OBS setup workflow. Every control hits the real loopback relay:
 * health polling, overlay-URL issuance, test triggers and the media
 * inventory. Process management (starting the relay itself) stays an
 * explicit terminal command — see docs/RELAY_LIFECYCLE.md for why the
 * webview cannot spawn it and how a Tauri sidecar would.
 */
export function RelayPanel({
  relayToken,
  setRelayToken,
  mediaFile,
  setMediaFile,
  volume,
  setVolume,
  durationMs,
  setDurationMs,
  relayStatus,
  cameraActive,
  onTestReaction,
}: RelayPanelProps) {
  const [health, setHealth] = useState<string>("Checking…");
  const [overlayUrl, setOverlayUrl] = useState<string>("");
  const [urlNote, setUrlNote] = useState<string>("");
  const [media, setMedia] = useState<MediaItem[] | null>(null);
  const [mediaNote, setMediaNote] = useState<string>("");
  const [audioNote, setAudioNote] = useState<string>("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Loopback health polling — unauthenticated by design (it reveals only
  // overlay count and boot id, no secrets).
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        try {
          const response = await fetch(`${RELAY_BASE}/api/health`, {
            signal: controller.signal,
          });
          if (!cancelled && response.ok) {
            const body = (await response.json()) as {
              connectedOverlays?: number;
              bootId?: string;
            };
            if (mountedRef.current) {
              setHealth(
                `Relay up · ${body.connectedOverlays ?? 0} overlay(s) · boot ${String(body.bootId ?? "?").slice(0, 8)}`
              );
            }
          } else if (!cancelled && mountedRef.current) {
            setHealth("Relay answered with an error — see terminal.");
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setHealth("Relay unreachable — run `npm run relay` in a terminal.");
        }
      }
    };
    void check();
    const interval = setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleCopyUrl = useCallback(async () => {
    setUrlNote("");
    if (!relayToken.trim()) {
      setUrlNote("Paste the publish token first (printed by `npm run relay`).");
      return;
    }
    try {
      const response = await fetch(`${RELAY_BASE}/api/overlay-url`, {
        method: "POST",
        headers: { Authorization: "Bearer " + relayToken.trim() },
      });
      if (!response.ok) {
        setUrlNote(
          response.status === 401
            ? "Relay rejected the token — copy it fresh from the relay terminal."
            : `Relay returned HTTP ${response.status}.`
        );
        return;
      }
      const body = (await response.json()) as { url?: string };
      if (!body.url) {
        setUrlNote("Relay did not return a URL.");
        return;
      }
      setOverlayUrl(body.url);
      const ok = await copyText(body.url);
      setUrlNote(
        ok
          ? "Copied — paste into OBS as a Browser Source URL."
          : "Copy failed — select the URL below manually."
      );
    } catch {
      setUrlNote("Relay unreachable — run `npm run relay` in a terminal.");
    }
  }, [relayToken]);

  const refreshMedia = useCallback(async () => {
    setMediaNote("");
    if (!relayToken.trim()) {
      setMediaNote("Paste the publish token to list relay media.");
      return;
    }
    try {
      const response = await fetch(`${RELAY_BASE}/api/media`, {
        headers: { Authorization: "Bearer " + relayToken.trim() },
      });
      if (response.status === 403) {
        setMediaNote("Relay rejected the token.");
        return;
      }
      if (!response.ok) {
        setMediaNote(`Relay returned HTTP ${response.status}.`);
        return;
      }
      const body = (await response.json()) as { media?: MediaItem[] };
      setMedia(body.media ?? []);
      if ((body.media ?? []).length === 0) {
        setMediaNote("No media on the relay — drop files into public/reactions/ and restart it.");
      }
    } catch {
      setMediaNote("Relay unreachable — run `npm run relay` in a terminal.");
    }
  }, [relayToken]);

  const probeAudio = useCallback(async () => {
    setAudioNote("Probing…");
    const result = await probeAudioPlayback();
    setAudioNote(
      result === "running"
        ? "AudioContext running here — sound should play. In OBS, enable “Control audio via OBS” on the Browser Source."
        : result === "suspended"
          ? "AudioContext suspended — click anywhere once, then retry. In OBS, check the Browser Source audio settings."
          : "No WebAudio available — sounds will be skipped but visuals still play."
    );
  }, []);

  const mediaKnown = media?.some((m) => m.name === mediaFile.trim()) ?? null;

  return (
    <details className="relay-settings">
      <summary>
        OBS Bridge · {relayStatus} · {health}
      </summary>
      <div className="relay-settings__fields">
        <label>
          Publish token (from npm run relay)
          <input
            type="password"
            value={relayToken}
            onChange={(e) => setRelayToken(e.target.value)}
            placeholder="Paste local relay publish token"
            autoComplete="off"
          />
        </label>
        <label>
          Optional local video/audio filename (public/reactions/)
          <input
            value={mediaFile}
            onChange={(e) => setMediaFile(e.target.value)}
            placeholder="example.webm (blank uses PNG meme frame)"
          />
        </label>
        <label>
          Volume (0–1)
          <input
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            placeholder="1"
            inputMode="decimal"
          />
        </label>
        <label>
          Duration override in ms (blank uses effect default)
          <input
            value={durationMs}
            onChange={(e) => setDurationMs(e.target.value)}
            placeholder="2700"
            inputMode="numeric"
          />
        </label>
        <small>
          {cameraActive
            ? "Webcam-expression mode: faces can trigger; manual buttons work too."
            : "Webcam-free manual mode: buttons publish to OBS without any camera."}{" "}
          Webcam frames never leave this app.
        </small>
      </div>
      <div className="relay-settings__fields">
        <button
          className="viewfinder__retry-btn"
          onClick={() => void handleCopyUrl()}
        >
          Copy OBS URL
        </button>
        <button
          className="viewfinder__retry-btn"
          onClick={onTestReaction}
          disabled={!relayToken.trim()}
          title={relayToken.trim() ? "Send a validated test reaction" : "Paste the publish token first"}
        >
          Send test reaction
        </button>
        <button
          className="viewfinder__retry-btn"
          onClick={() => void refreshMedia()}
        >
          Check relay media
        </button>
        <button
          className="viewfinder__retry-btn"
          onClick={() => void probeAudio()}
        >
          Probe audio
        </button>
        <small>
          Start the relay with `npm run relay`, paste its OBS URL into OBS as a
          Browser Source (transparent background), then use the buttons above.
          In-app relay start/stop needs a Tauri sidecar — see
          docs/RELAY_LIFECYCLE.md.
        </small>
      </div>
      {(urlNote || overlayUrl) && (
        <div className="viewfinder__error-detail" role="status">
          {urlNote && <div>{urlNote}</div>}
          {overlayUrl && <div>{overlayUrl}</div>}
        </div>
      )}
      {mediaNote && (
        <div className="viewfinder__error-detail" role="status">
          {mediaNote}
        </div>
      )}
      {media && media.length > 0 && (
        <div className="viewfinder__error-detail" role="status">
          {media.map((m) => (
            <div key={m.name}>
              {m.kind} · {m.name} · {(m.bytes / 1024).toFixed(1)} KB
            </div>
          ))}
          {mediaFile.trim() &&
            (mediaKnown
              ? ` — “${mediaFile.trim()}” is on the relay.`
              : ` — “${mediaFile.trim()}” is NOT on the relay; triggers using it will be rejected.`)}
        </div>
      )}
      {audioNote && (
        <div className="viewfinder__error-detail" role="status">
          {audioNote}
          {" "}If OBS stays silent: unmute the Browser Source, enable “Control
          audio via OBS”, and confirm the source isn’t hidden (hidden sources
          may not render audio).
        </div>
      )}
    </details>
  );
}

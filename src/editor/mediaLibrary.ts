import { MediaFileSchema, mediaKindForFile } from "../effects/effectSchemas";

/** Relay parity: 50 MB, same as scripts/overlay-relay.mjs MAX_FILE_BYTES. */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export type MediaKind = "image" | "video" | "audio";

export interface MediaValidation {
  ok: boolean;
  reason?: string;
}

export interface MediaFileLike {
  name: string;
  size: number;
  type: string;
}

/**
 * Pure import validation. Extension allowlist and traversal rules match the
 * relay exactly; MIME is advisory (browsers lie) so mismatches warn rather
 * than reject when the extension is valid.
 */
export function validateMediaFile(file: MediaFileLike): MediaValidation {
  if (!file.name || file.name.length > 128) {
    return { ok: false, reason: "Filename must be 1–128 characters." };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.name)) {
    return {
      ok: false,
      reason: "Use a plain filename (letters, digits, dot, dash, underscore) — no paths.",
    };
  }
  if (file.name === "." || file.name === "..") {
    return { ok: false, reason: "Invalid filename." };
  }
  if (MediaFileSchema.safeParse(file.name).success !== true) {
    return {
      ok: false,
      reason: "Unsupported type. Use PNG/JPEG/WebP/GIF, MP4/WebM, or MP3/WAV/OGG.",
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: "Empty files cannot be imported." };
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return { ok: false, reason: "Files over 50 MB are rejected (relay limit)." };
  }
  const kind = mediaKindForFile(file.name);
  if (kind === null) {
    return { ok: false, reason: "Unsupported media extension." };
  }
  if (file.type) {
    const major = file.type.split("/")[0];
    const expected =
      kind === "image" ? "image" : kind === "video" ? "video" : "audio";
    if (major !== expected && major !== "application") {
      return {
        ok: true,
        reason: `MIME "${file.type}" disagrees with the extension; trusting the extension.`,
      };
    }
  }
  return { ok: true };
}

export interface MediaRecord {
  name: string;
  kind: MediaKind;
  bytes: number;
  mime: string;
  url: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** False after reload until the file is re-imported (blobs don't persist). */
  available: boolean;
}

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * Probe dimensions/duration from an object URL. Never rejects: unplayable
 * files resolve to nulls and surface a warning downstream instead of
 * breaking the import flow.
 */
export function probeMediaMetadata(
  url: string,
  kind: MediaKind,
  timeoutMs = 8000
): Promise<MediaMetadata> {
  const fallback: MediaMetadata = { width: null, height: null, durationMs: null };
  return new Promise((resolve) => {
    let settled = false;
    const done = (meta: MediaMetadata): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(meta);
      }
    };
    const timer = setTimeout(() => done(fallback), timeoutMs);
    try {
      if (kind === "image") {
        const img = new Image();
        img.onload = () =>
          done({
            width: img.naturalWidth || null,
            height: img.naturalHeight || null,
            durationMs: null,
          });
        img.onerror = () => done(fallback);
        img.src = url;
        return;
      }
      const media = document.createElement(kind === "video" ? "video" : "audio");
      media.preload = "metadata";
      media.onloadedmetadata = () =>
        done({
          width:
            kind === "video"
              ? (media as HTMLVideoElement).videoWidth || null
              : null,
          height:
            kind === "video"
              ? (media as HTMLVideoElement).videoHeight || null
              : null,
          durationMs: Number.isFinite(media.duration)
            ? Math.round(media.duration * 1000)
            : null,
        });
      media.onerror = () => done(fallback);
      media.src = url;
    } catch {
      done(fallback);
    }
  });
}

/**
 * Session media registry. Blobs and object URLs live here ONLY — pack JSON
 * carries filenames, so localStorage can never fill with video binaries.
 * `remove()` revokes the object URL; callers must confirm first when the
 * usage count is non-zero.
 */
export class MediaRegistry {
  private readonly records = new Map<string, MediaRecord>();

  add(record: MediaRecord): void {
    // Reimporting the same filename replaces the entry: release the stale
    // object URL first so repeated imports never leak blobs.
    const previous = this.records.get(record.name);
    if (previous && previous.url !== record.url) {
      try {
        URL.revokeObjectURL(previous.url);
      } catch {
        // Revocation is best-effort; the record is still replaced.
      }
    }
    this.records.set(record.name, record);
  }

  get(name: string): MediaRecord | undefined {
    return this.records.get(name);
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  list(): MediaRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  remove(name: string): boolean {
    const record = this.records.get(name);
    if (!record) return false;
    try {
      URL.revokeObjectURL(record.url);
    } catch {
      // Revocation is best-effort; the record is still dropped.
    }
    return this.records.delete(name);
  }

  clear(): void {
    for (const name of [...this.records.keys()]) this.remove(name);
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * Apply async probe metadata only when the record still points at the
 * probed URL. A file replaced (or removed) mid-probe must never receive
 * stale dimensions/duration.
 */
export function applyProbeResult(
  registry: MediaRegistry,
  name: string,
  url: string,
  meta: MediaMetadata
): boolean {
  const current = registry.get(name);
  if (!current || current.url !== url) return false;
  registry.add({ ...current, ...meta });
  return true;
}

export function searchMedia(
  records: MediaRecord[],
  query: string,
  kind: MediaKind | "all"
): MediaRecord[] {
  const q = query.trim().toLowerCase();
  return records.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      String(r.bytes).includes(q) ||
      r.kind.includes(q)
    );
  });
}

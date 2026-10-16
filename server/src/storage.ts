import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { signUrl } from "./crypto.ts";
import { MAX_MEDIA_BYTES } from "./types.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};
const ALLOWED_EXT = new Set(Object.keys(MIME));

export function kindForExt(ext: string): "video" | "audio" | "image" | null {
  const mime = MIME[ext];
  if (!mime) return null;
  if (mime.startsWith("video")) return "video";
  if (mime.startsWith("audio")) return "audio";
  return "image";
}

export function validMediaName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) &&
    name !== "." &&
    name !== ".." &&
    ALLOWED_EXT.has(extname(name).toLowerCase())
  );
}

/** Magic-byte sniffing, mirrored from the local relay. */
export function sniffKind(head: Uint8Array, ext: string): "video" | "audio" | "image" | null {
  const has = (...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b);
  const ascii = (offset: number, text: string): boolean =>
    Buffer.from(head.slice(offset, offset + text.length)).toString("binary") === text;
  if (ext === ".png") return has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ? "image" : null;
  if (ext === ".jpg" || ext === ".jpeg") return has(0xff, 0xd8, 0xff) ? "image" : null;
  if (ext === ".gif") return ascii(0, "GIF87a") || ascii(0, "GIF89a") ? "image" : null;
  if (ext === ".webp") return ascii(0, "RIFF") && ascii(8, "WEBP") ? "image" : null;
  if (ext === ".mp4") return ascii(4, "ftyp") ? "video" : null;
  if (ext === ".webm") return has(0x1a, 0x45, 0xdf, 0xa3) ? "video" : null;
  if (ext === ".mp3") return ascii(0, "ID3") || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) ? "audio" : null;
  if (ext === ".wav") return ascii(0, "RIFF") && ascii(8, "WAVE") ? "audio" : null;
  if (ext === ".ogg") return ascii(0, "OggS") ? "audio" : null;
  return null;
}

export type StorageErrorCode =
  | "invalid filename"
  | "empty file"
  | "file too large"
  | "content does not match the filename"
  | "exists"
  | "not found"
  | "quota exceeded"
  | "upload in progress";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  constructor(message: string, code: StorageErrorCode) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface StoredFile {
  bytes: number;
  kind: "video" | "audio" | "image";
  storageKey: string;
  version: number;
}

function workspaceDir(root: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(workspaceId)) throw new StorageError("Invalid workspace.", "invalid filename");
  const dir = resolve(join(root, workspaceId));
  if (dir !== resolve(root) && !dir.startsWith(resolve(root) + sep)) {
    throw new StorageError("Invalid workspace.", "invalid filename");
  }
  return dir;
}

function filePath(root: string, workspaceId: string, name: string): string {
  if (!validMediaName(name)) throw new StorageError("That filename is not allowed.", "invalid filename");
  const dir = workspaceDir(root, workspaceId);
  const target = resolve(join(dir, name));
  if (target !== resolve(join(dir, basename(name))) || !target.startsWith(dir + sep)) {
    throw new StorageError("That filename is not allowed.", "invalid filename");
  }
  return target;
}

/**
 * Private media storage. Filesystem backend serves tests/dev; S3-compatible
 * providers plug in via S3StorageConfig without ever exposing credentials
 * to clients (all signing happens server-side).
 */
export class FilesystemStorage {
  private inFlight = new Set<string>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Stream `body` to disk with bounded memory, validate, then atomically publish. */
  async put(workspaceId: string, name: string, body: AsyncIterable<Uint8Array>, declaredBytes: number | null, currentUsageBytes: number, quotaBytes: number): Promise<StoredFile> {
    const full = filePath(this.root, workspaceId, name);
    const key = `${workspaceId}:${name}`;
    if (this.inFlight.has(key)) throw new StorageError("That file is already uploading.", "upload in progress");
    if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > MAX_MEDIA_BYTES) {
      throw new StorageError("Files over 50 MB are rejected.", "file too large");
    }
    if (currentUsageBytes >= quotaBytes) throw new StorageError("Workspace storage quota exceeded.", "quota exceeded");
    this.inFlight.add(key);
    try {
      const existing = await stat(full).catch(() => null);
      if (existing?.isFile()) throw new StorageError("A file with that name already exists.", "exists");
      const dir = workspaceDir(this.root, workspaceId);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.upload-${randomBytes(8).toString("hex")}.part`);
      let received = 0;
      let streamError: unknown = null;
      try {
        const out = createWriteStream(tmp);
        const finished = new Promise<void>((ok, bad) => {
          out.on("finish", ok);
          out.on("error", bad);
        });
        try {
          for await (const chunk of body) {
            received += chunk.length;
            if (received <= MAX_MEDIA_BYTES && currentUsageBytes + received <= quotaBytes) {
              if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
            }
          }
        } catch (err) {
          streamError = err;
        }
        try {
          out.end();
        } catch {
          // ignore
        }
        if (!streamError) {
          try {
            await finished;
          } catch (err) {
            streamError = err;
          }
        }
        if (streamError) {
          await unlink(tmp).catch(() => undefined);
          throw streamError;
        }
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      if (received === 0) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("Empty files cannot be uploaded.", "empty file");
      }
      if (received > MAX_MEDIA_BYTES) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("Files over 50 MB are rejected.", "file too large");
      }
      if (currentUsageBytes + received > quotaBytes) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("Workspace storage quota exceeded.", "quota exceeded");
      }
      const raced = await stat(full).catch(() => null);
      if (raced?.isFile()) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("A file with that name already exists.", "exists");
      }
      const ext = extname(name).toLowerCase();
      const expected = kindForExt(ext);
      let head: Uint8Array | null = null;
      try {
        const handle = await open(tmp, "r");
        try {
          const buffer = Buffer.alloc(32);
          const { bytesRead } = await handle.read(buffer, 0, 32, 0);
          head = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close().catch(() => undefined);
        }
      } catch {
        head = null;
      }
      if (!head || head.length === 0 || !expected || sniffKind(head, ext) !== expected) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("File content does not match its extension.", "content does not match the filename");
      }
      await rename(tmp, full);
      return { bytes: received, kind: expected, storageKey: `${workspaceId}/${name}`, version: 1 };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Atomic versioned replacement: writes the new bytes, swaps, bumps version. */
  async replace(workspaceId: string, name: string, body: AsyncIterable<Uint8Array>, declaredBytes: number | null, usageExcludingFile: number, quotaBytes: number, prevVersion: number): Promise<StoredFile> {
    if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > MAX_MEDIA_BYTES) {
      throw new StorageError("Files over 50 MB are rejected.", "file too large");
    }
    const full = filePath(this.root, workspaceId, name);
    const existing = await stat(full).catch(() => null);
    if (!existing?.isFile()) throw new StorageError("File not found.", "not found");
    const dir = workspaceDir(this.root, workspaceId);
    const tmp = join(dir, `.upload-${randomBytes(8).toString("hex")}.part`);
    let received = 0;
    try {
      const out = createWriteStream(tmp);
      const finished = new Promise<void>((ok, bad) => {
        out.on("finish", ok);
        out.on("error", bad);
      });
      for await (const chunk of body) {
        received += chunk.length;
        if (received <= MAX_MEDIA_BYTES && usageExcludingFile + received <= quotaBytes) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
        }
      }
      out.end();
      await finished;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    if (received === 0 || received > MAX_MEDIA_BYTES || usageExcludingFile + received > quotaBytes) {
      await unlink(tmp).catch(() => undefined);
      throw new StorageError(received === 0 ? "Empty files cannot be uploaded." : "File rejected (size or quota).", received === 0 ? "empty file" : "file too large");
    }
    const ext = extname(name).toLowerCase();
    const expected = kindForExt(ext);
    const handle = await open(tmp, "r");
    let head: Uint8Array;
    try {
      const buffer = Buffer.alloc(32);
      const { bytesRead } = await handle.read(buffer, 0, 32, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!expected || sniffKind(head, ext) !== expected) {
      await unlink(tmp).catch(() => undefined);
      throw new StorageError("File content does not match its extension.", "content does not match the filename");
    }
    await rename(tmp, full);
    return { bytes: received, kind: expected, storageKey: `${workspaceId}/${name}`, version: prevVersion + 1 };
  }

  async remove(workspaceId: string, name: string): Promise<boolean> {
    const full = filePath(this.root, workspaceId, name);
    return unlink(full).then(() => true).catch(() => false);
  }

  async list(workspaceId: string): Promise<Array<{ name: string; bytes: number; kind: "video" | "audio" | "image" }>> {
    const dir = workspaceDir(this.root, workspaceId);
    const entries = await readdir(dir).catch(() => []);
    const items: Array<{ name: string; bytes: number; kind: "video" | "audio" | "image" }> = [];
    for (const name of entries) {
      if (!validMediaName(name)) continue;
      const full = filePath(this.root, workspaceId, name);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      const kind = kindForExt(extname(name).toLowerCase());
      if (kind) items.push({ name, bytes: info.size, kind });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  stream(workspaceId: string, name: string): ReturnType<typeof createReadStream> {
    return createReadStream(filePath(this.root, workspaceId, name));
  }

  async residue(): Promise<string[]> {
    const out: string[] = [];
    const workspaces = await readdir(this.root).catch(() => []);
    for (const ws of workspaces) {
      const files = await readdir(join(this.root, ws)).catch(() => []);
      for (const f of files) if (f.startsWith(".upload-") && f.endsWith(".part")) out.push(`${ws}/${f}`);
    }
    return out;
  }
}

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  forcePathStyle?: boolean;
}

/** Read S3-compatible config from the environment. Credentials are never returned to clients. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageConfig | null {
  const endpoint = (env["LIVE_EDITS_S3_ENDPOINT"] || "").trim();
  const bucket = (env["LIVE_EDITS_S3_BUCKET"] || "").trim();
  if (!endpoint || !bucket) return null;
  return {
    endpoint,
    region: (env["LIVE_EDITS_S3_REGION"] || "auto").trim() || "auto",
    bucket,
    accessKeyIdEnv: "LIVE_EDITS_S3_ACCESS_KEY",
    secretAccessKeyEnv: "LIVE_EDITS_S3_SECRET_KEY",
    forcePathStyle: (env["LIVE_EDITS_S3_FORCE_PATH_STYLE"] || "").trim() === "1",
  };
}

/** Placeholder that documents the provider handoff without exposing secrets. */
export function connectS3(config: S3StorageConfig | null): { configured: boolean; detail: string } {
  if (!config) {
    return { configured: false, detail: "S3 not configured; using private filesystem storage. Set LIVE_EDITS_S3_ENDPOINT + LIVE_EDITS_S3_BUCKET (+ keys) to use a compatible provider." };
  }
  const hasKeys = Boolean(process.env[config.accessKeyIdEnv]) && Boolean(process.env[config.secretAccessKeyEnv]);
  if (!hasKeys) throw new Error(`S3 endpoint/bucket set but credentials missing (${config.accessKeyIdEnv}/${config.secretAccessKeyEnv}).`);
  return { configured: true, detail: `S3 provider ${config.endpoint} bucket ${config.bucket} (credentials server-side only).` };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function signMediaUrl(secret: string, workspaceId: string, name: string, expiresAt: number): string {
  const payload = `${workspaceId}:${name}:${expiresAt}`;
  return signUrl(secret, payload);
}

export function verifyMediaUrl(secret: string, workspaceId: string, name: string, expiresAt: number, signature: string): boolean {
  if (!Number.isInteger(expiresAt) || Date.now() > expiresAt) return false;
  const expected = signMediaUrl(secret, workspaceId, name, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return (Buffer as unknown as { timingSafeEqual: (x: Buffer, y: Buffer) => boolean }).timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

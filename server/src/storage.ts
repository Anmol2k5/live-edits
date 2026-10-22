import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
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

export interface ByteRange {
  start: number;
  end: number;
}

/** Storage backend contract: private per-workspace media. Both the
 * filesystem backend (tests/dev) and the S3 backend (production
 * providers like MinIO) implement it; credentials never leave the server. */
export interface MediaStorage {
  init(): Promise<void>;
  put(
    workspaceId: string,
    name: string,
    body: AsyncIterable<Uint8Array>,
    declaredBytes: number | null,
    currentUsageBytes: number,
    quotaBytes: number
  ): Promise<StoredFile>;
  replace(
    workspaceId: string,
    name: string,
    body: AsyncIterable<Uint8Array>,
    declaredBytes: number | null,
    usageExcludingFile: number,
    quotaBytes: number,
    prevVersion: number
  ): Promise<StoredFile>;
  remove(workspaceId: string, name: string): Promise<boolean>;
  list(workspaceId: string): Promise<Array<{ name: string; bytes: number; kind: "video" | "audio" | "image" }>>;
  stream(workspaceId: string, name: string, range?: ByteRange): NodeJS.ReadableStream;
  describe(): string;
}

/** Spool a body to a temp file with bounded memory, enforcing the size cap
 * and quota as bytes arrive; then sniff content vs extension. Shared by
 * both backends so validation is identical everywhere. */
async function spoolAndValidate(
  tmpPath: string,
  body: AsyncIterable<Uint8Array>,
  declaredBytes: number | null,
  usageBefore: number,
  quotaBytes: number,
  name: string
): Promise<{ bytes: number; kind: "video" | "audio" | "image" }> {
  if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > MAX_MEDIA_BYTES) {
    throw new StorageError("Files over 50 MB are rejected.", "file too large");
  }
  let received = 0;
  const out = createWriteStream(tmpPath);
  const finished = new Promise<void>((ok, bad) => {
    out.on("finish", ok);
    out.on("error", bad);
  });
  let streamError: unknown = null;
  try {
    for await (const chunk of body) {
      received += chunk.length;
      if (received <= MAX_MEDIA_BYTES && usageBefore + received <= quotaBytes) {
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
    await unlink(tmpPath).catch(() => undefined);
    throw streamError;
  }
  if (received === 0) {
    await unlink(tmpPath).catch(() => undefined);
    throw new StorageError("Empty files cannot be uploaded.", "empty file");
  }
  if (received > MAX_MEDIA_BYTES) {
    await unlink(tmpPath).catch(() => undefined);
    throw new StorageError("Files over 50 MB are rejected.", "file too large");
  }
  if (usageBefore + received > quotaBytes) {
    await unlink(tmpPath).catch(() => undefined);
    throw new StorageError("Workspace storage quota exceeded.", "quota exceeded");
  }
  const ext = extname(name).toLowerCase();
  const expected = kindForExt(ext);
  let head: Uint8Array | null = null;
  try {
    const handle = await open(tmpPath, "r");
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
    await unlink(tmpPath).catch(() => undefined);
    throw new StorageError("File content does not match its extension.", "content does not match the filename");
  }
  return { bytes: received, kind: expected };
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
export class FilesystemStorage implements MediaStorage {
  private inFlight = new Set<string>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  describe(): string {
    return `filesystem storage at ${this.root}`;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Stream `body` to disk with bounded memory, validate, then atomically publish. */
  async put(workspaceId: string, name: string, body: AsyncIterable<Uint8Array>, declaredBytes: number | null, currentUsageBytes: number, quotaBytes: number): Promise<StoredFile> {
    const full = filePath(this.root, workspaceId, name);
    const key = `${workspaceId}:${name}`;
    if (this.inFlight.has(key)) throw new StorageError("That file is already uploading.", "upload in progress");
    if (currentUsageBytes >= quotaBytes) throw new StorageError("Workspace storage quota exceeded.", "quota exceeded");
    this.inFlight.add(key);
    try {
      const existing = await stat(full).catch(() => null);
      if (existing?.isFile()) throw new StorageError("A file with that name already exists.", "exists");
      const dir = workspaceDir(this.root, workspaceId);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.upload-${randomBytes(8).toString("hex")}.part`);
      const { bytes, kind } = await spoolAndValidate(tmp, body, declaredBytes, currentUsageBytes, quotaBytes, name);
      const raced = await stat(full).catch(() => null);
      if (raced?.isFile()) {
        await unlink(tmp).catch(() => undefined);
        throw new StorageError("A file with that name already exists.", "exists");
      }
      await rename(tmp, full);
      return { bytes, kind, storageKey: `${workspaceId}/${name}`, version: 1 };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Atomic versioned replacement: validates the new bytes, swaps, bumps version. */
  async replace(workspaceId: string, name: string, body: AsyncIterable<Uint8Array>, declaredBytes: number | null, usageExcludingFile: number, quotaBytes: number, prevVersion: number): Promise<StoredFile> {
    const full = filePath(this.root, workspaceId, name);
    const existing = await stat(full).catch(() => null);
    if (!existing?.isFile()) throw new StorageError("File not found.", "not found");
    const dir = workspaceDir(this.root, workspaceId);
    const tmp = join(dir, `.upload-${randomBytes(8).toString("hex")}.part`);
    const { bytes, kind } = await spoolAndValidate(tmp, body, declaredBytes, usageExcludingFile, quotaBytes, name);
    await rename(tmp, full);
    return { bytes, kind, storageKey: `${workspaceId}/${name}`, version: prevVersion + 1 };
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

  stream(workspaceId: string, name: string, range?: ByteRange): NodeJS.ReadableStream {
    const full = filePath(this.root, workspaceId, name);
    return range ? createReadStream(full, { start: range.start, end: range.end }) : createReadStream(full);
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

export interface S3ResolvedConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Resolve credentials server-side; throws when partially configured (fail closed). */
export function resolveS3Config(env: NodeJS.ProcessEnv = process.env): S3ResolvedConfig | null {
  const base = s3ConfigFromEnv(env);
  if (!base) return null;
  const accessKeyId = (env[base.accessKeyIdEnv] || "").trim();
  const secretAccessKey = env[base.secretAccessKeyEnv] ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`S3 endpoint/bucket set but credentials missing (${base.accessKeyIdEnv}/${base.secretAccessKeyEnv}).`);
  }
  return { endpoint: base.endpoint, region: base.region, bucket: base.bucket, accessKeyId, secretAccessKey, forcePathStyle: base.forcePathStyle ?? false };
}

/**
 * S3-compatible object storage (MinIO and similar). Objects live at
 * `<workspace>/<name>`; uploads spool through a validated temp file first
 * so content rules match the filesystem backend byte for byte. Delivery is
 * proxied through the app (tenant-checked, revocable) — provider
 * credentials are never exposed and no presigned URLs leak scope.
 */
export class S3Storage implements MediaStorage {
  private inFlight = new Set<string>();
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly config: S3ResolvedConfig;
  private readonly stagingDir: string;

  constructor(config: S3ResolvedConfig, stagingDir: string, client?: S3Client) {
    this.config = config;
    this.stagingDir = stagingDir;
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region === "auto" ? "us-east-1" : config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        forcePathStyle: config.forcePathStyle,
      });
  }

  describe(): string {
    return `s3 storage at ${this.config.endpoint} bucket ${this.bucket} (credentials server-side only)`;
  }

  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    await mkdir(this.stagingDir, { recursive: true });
  }

  private key(workspaceId: string, name: string): string {
    if (!validMediaName(name)) throw new StorageError("That filename is not allowed.", "invalid filename");
    if (!/^[0-9a-fA-F-]{8,64}$/.test(workspaceId)) throw new StorageError("Invalid workspace.", "invalid filename");
    return `${workspaceId}/${name}`;
  }

  private stagePath(): string {
    return join(this.stagingDir, `.upload-${randomBytes(8).toString("hex")}.part`);
  }

  async put(
    workspaceId: string,
    name: string,
    body: AsyncIterable<Uint8Array>,
    declaredBytes: number | null,
    currentUsageBytes: number,
    quotaBytes: number
  ): Promise<StoredFile> {
    const objectKey = this.key(workspaceId, name);
    const flight = `${workspaceId}:${name}`;
    if (this.inFlight.has(flight)) throw new StorageError("That file is already uploading.", "upload in progress");
    if (currentUsageBytes >= quotaBytes) throw new StorageError("Workspace storage quota exceeded.", "quota exceeded");
    this.inFlight.add(flight);
    const tmp = this.stagePath();
    try {
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
        throw new StorageError("A file with that name already exists.", "exists");
      } catch (err) {
        if (err instanceof StorageError) throw err;
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw err;
      }
      const { bytes, kind } = await spoolAndValidate(tmp, body, declaredBytes, currentUsageBytes, quotaBytes, name);
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: createReadStream(tmp) as unknown as Uint8Array, ContentLength: bytes, IfNoneMatch: "*" })
        );
      } catch (err) {
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) throw new StorageError("A file with that name already exists.", "exists");
        throw err;
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
      return { bytes, kind, storageKey: `s3:${this.bucket}/${objectKey}`, version: 1 };
    } finally {
      this.inFlight.delete(flight);
      await unlink(tmp).catch(() => undefined);
    }
  }

  async replace(
    workspaceId: string,
    name: string,
    body: AsyncIterable<Uint8Array>,
    declaredBytes: number | null,
    usageExcludingFile: number,
    quotaBytes: number,
    prevVersion: number
  ): Promise<StoredFile> {
    const objectKey = this.key(workspaceId, name);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch {
      throw new StorageError("File not found.", "not found");
    }
    const tmp = this.stagePath();
    try {
      const { bytes, kind } = await spoolAndValidate(tmp, body, declaredBytes, usageExcludingFile, quotaBytes, name);
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: createReadStream(tmp) as unknown as Uint8Array, ContentLength: bytes })
      );
      return { bytes, kind, storageKey: `s3:${this.bucket}/${objectKey}`, version: prevVersion + 1 };
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async remove(workspaceId: string, name: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(workspaceId, name) }));
      return true;
    } catch {
      return false;
    }
  }

  async list(workspaceId: string): Promise<Array<{ name: string; bytes: number; kind: "video" | "audio" | "image" }>> {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(workspaceId)) throw new StorageError("Invalid workspace.", "invalid filename");
    const items: Array<{ name: string; bytes: number; kind: "video" | "audio" | "image" }> = [];
    let token: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${workspaceId}/`, MaxKeys: 1000, ContinuationToken: token })
      );
      for (const obj of page.Contents ?? []) {
        const full = obj.Key ?? "";
        const name = full.startsWith(`${workspaceId}/`) ? full.slice(workspaceId.length + 1) : "";
        if (!validMediaName(name)) continue;
        const kind = kindForExt(extname(name).toLowerCase());
        if (kind) items.push({ name, bytes: obj.Size ?? 0, kind });
      }
      if (!page.IsTruncated) break;
      token = page.NextContinuationToken;
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  stream(workspaceId: string, name: string, range?: ByteRange): NodeJS.ReadableStream {
    const out = new PassThrough();
    void (async () => {
      try {
        const response = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.key(workspaceId, name),
            ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
          })
        );
        const body = response.Body as unknown as AsyncIterable<Uint8Array> | undefined;
        if (!body) {
          out.destroy(new Error("empty s3 body"));
          return;
        }
        for await (const chunk of body) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
        }
        out.end();
      } catch (err) {
        out.destroy(err as Error);
      }
    })();
    return out;
  }
}

/** Select the configured backend: S3 when fully configured, else filesystem. */
export async function createStorageFromEnv(opts: { storageDir: string; env?: NodeJS.ProcessEnv }): Promise<MediaStorage> {
  const env = opts.env ?? process.env;
  const resolved = resolveS3Config(env);
  if (resolved) {
    const staging = join(opts.storageDir, ".spool");
    return new S3Storage(resolved, staging);
  }
  return new FilesystemStorage(opts.storageDir);
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
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

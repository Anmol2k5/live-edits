import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(parts[4] ?? "", "hex");
    const expected = Buffer.from(parts[5] ?? "", "hex");
    const derived = scryptSync(password, salt, expected.length, { N, r, p });
    return salt.length === 16 && expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signUrl(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

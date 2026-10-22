// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { api, register, createWorkspace, samplePack, wavBytes, startTestApp } from "./test-helpers.ts";
import { createSaasApp, validateProductionConfig } from "./app.ts";
import { MemoryStore } from "./store.ts";
import { FilesystemStorage, validMediaName, sniffKind, kindForExt } from "./storage.ts";
import { InMemoryEmailProvider, SmtpEmailProvider, emailProviderFromEnv, resetUrlFor } from "./email.ts";
import { readMigrationSql } from "./store.ts";

function cookiesFrom(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = response.headers.get("set-cookie");
  if (!raw) return out;
  for (const part of raw.split(/,(?=[^;,]+=[^;,]*;)/)) {
    const eq = part.indexOf("=");
    const semi = part.indexOf(";");
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1, semi < 0 ? undefined : semi).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

async function loginCookie(base: string, email: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  const body = (await response.json()) as { csrfToken: string };
  const cookies = cookiesFrom(response);
  await response.arrayBuffer().catch(() => undefined);
  return { cookie: `le_session=${cookies["le_session"] ?? ""}`, csrf: body.csrfToken };
}

describe("saas csrf protection (M7.1)", () => {
  it("requires the double-submit token for cookie-authenticated writes", async () => {
    const app = await startTestApp();
    try {
      await register(app.base, "csrf@example.com");
      const { cookie, csrf } = await loginCookie(app.base, "csrf@example.com", "correct-horse-99");

      const without = await fetch(`${app.base}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(without.status).toBe(403);
      await without.arrayBuffer().catch(() => undefined);

      const wrong = await fetch(`${app.base}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": "wrong" },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(wrong.status).toBe(403);
      await wrong.arrayBuffer().catch(() => undefined);

      const withToken = await fetch(`${app.base}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
        body: JSON.stringify({ name: "Safe" }),
      });
      expect(withToken.status).toBe(201);
      await withToken.arrayBuffer().catch(() => undefined);
    } finally {
      await app.close();
    }
  });

  it("exempts Bearer-authenticated writes from CSRF", async () => {
    const app = await startTestApp();
    try {
      const reg = await register(app.base, "bearer@example.com");
      const res = await api(app.base, "POST", "/api/workspaces", reg.token, { name: "Bearer WS" });
      expect(res.status).toBe(201);
    } finally {
      await app.close();
    }
  });
});

describe("saas rate limiting and headers (M7.1)", () => {
  it("throttles login attempts with Retry-After", async () => {
    const app = await startTestApp();
    try {
      await register(app.base, "rl@example.com");
      let limited = 0;
      let retryAfter = "";
      for (let i = 0; i < 15; i += 1) {
        const res = await fetch(`${app.base}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "rl@example.com", password: "wrong-password-1" }),
        });
        await res.arrayBuffer().catch(() => undefined);
        if (res.status === 429) {
          limited += 1;
          retryAfter = res.headers.get("retry-after") ?? "";
        }
      }
      expect(limited).toBeGreaterThan(0);
      expect(retryAfter).not.toBe("");
    } finally {
      await app.close();
    }
  });

  it("sends baseline security headers on API responses", async () => {
    const app = await startTestApp();
    try {
      const res = await fetch(`${app.base}/api/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      await res.arrayBuffer().catch(() => undefined);
    } finally {
      await app.close();
    }
  });
});

describe("saas session inventory (M7.1)", () => {
  it("lists sessions and revokes others without exposing hashes", async () => {
    const app = await startTestApp();
    try {
      const reg = await register(app.base, "sess@example.com");
      const second = await api(app.base, "POST", "/api/auth/login", undefined, { email: "sess@example.com", password: "correct-horse-99" });
      expect(second.status).toBe(200);
      const list = await api(app.base, "GET", "/api/auth/sessions", reg.token);
      expect(list.status).toBe(200);
      const sessions = (list.json as { sessions: Array<{ id: string; current: boolean }> }).sessions;
      expect(sessions).toHaveLength(2);
      expect(JSON.stringify(list.json)).not.toMatch(/tokenHash|csrf/i);
      const revoke = await api(app.base, "DELETE", "/api/auth/sessions", reg.token);
      expect(revoke.status).toBe(200);
      expect((await api(app.base, "GET", "/api/auth/me", (second.json as { token: string }).token)).status).toBe(401);
      expect((await api(app.base, "GET", "/api/auth/me", reg.token)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("saas production gate and email providers (M7.1)", () => {
  it("fails closed when production configuration is incomplete", () => {
    const full = { nodeEnv: "production", sessionSecret: "x".repeat(40), cookieSecure: true, databaseUrl: "postgres://db/x", emailConfigured: true, persistentStore: true, appBaseUrl: "https://app.example.com" };
    expect(() => validateProductionConfig(full)).not.toThrow();
    expect(() => validateProductionConfig({ ...full, sessionSecret: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => validateProductionConfig({ ...full, cookieSecure: false })).toThrow(/COOKIE_SECURE/);
    expect(() => validateProductionConfig({ ...full, databaseUrl: "" })).toThrow(/DATABASE_URL/);
    expect(() => validateProductionConfig({ ...full, persistentStore: false })).toThrow(/persistent store/);
    expect(() => validateProductionConfig({ ...full, emailConfigured: false })).toThrow(/SMTP_HOST/);
    for (const appBaseUrl of ["", "not-a-url", "javascript:alert(1)", "https://user:pass@app.example.com", "https://app.example.com/#attacker"]) {
      expect(() => validateProductionConfig({ ...full, appBaseUrl })).toThrow(/APP_BASE_URL/);
    }
    expect(() => validateProductionConfig({ ...full, nodeEnv: "test" })).not.toThrow();
  });

  it("resolves email providers from the environment", () => {
    expect(() => emailProviderFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST/);
    const dev = emailProviderFromEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(dev.provider.constructor.name).toBe("LoggingEmailProvider");
    expect(() => emailProviderFromEnv({ NODE_ENV: "production", SMTP_HOST: "mail.example.com" } as NodeJS.ProcessEnv)).toThrow(/SMTP_USER/);
    const smtp = emailProviderFromEnv({
      NODE_ENV: "production", SMTP_HOST: "mail.example.com", SMTP_PORT: "587",
      SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "noreply@example.com",
    } as NodeJS.ProcessEnv);
    expect(smtp.provider.constructor.name).toBe("SmtpEmailProvider");
    expect(resetUrlFor("https://app.example.com/", "tok en")).toBe("https://app.example.com/#/recover?token=tok%20en");
  });

  it("captures recovery mail in memory without exposing tokens", async () => {
    const mail = new InMemoryEmailProvider();
    await mail.sendPasswordReset("u@example.com", resetUrlFor("https://app.example.com", "abc123"), Date.now() + 1000);
    expect(mail.tokenFor("u@example.com")).toBe("abc123");
    expect(mail.tokenFor("nobody@example.com")).toBeNull();
  });

  it.each(["", "https://app.example.com/dashboard"])("ignores the request Host when building recovery links (%s)", async (appBaseUrl) => {
    const email = new InMemoryEmailProvider();
    const storage = new FilesystemStorage(mkdtempSync(join(tmpdir(), "saas-recovery-host-")));
    const app = createSaasApp({ store: new MemoryStore(), storage, email, appBaseUrl });
    const { base } = await app.listen(0);
    try {
      await register(base, "host@example.com");
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${base}/api/auth/recover/request`, { method: "POST", headers: { Host: "attacker.example", "Content-Type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ email: "host@example.com" }));
      });
      expect(status).toBe(200);
      expect(email.sent).toHaveLength(1);
      const expectedBase = appBaseUrl || "http://127.0.0.1:1420";
      expect(email.sent[0].resetUrl).toBe(resetUrlFor(expectedBase, email.tokenFor("host@example.com")!));
    } finally {
      await app.close();
    }
  });

  it("delivers recovery mail over real SMTP", async () => {
    const { createServer } = await import("node:net");
    const received: string[] = [];
    const envelope: string[] = [];
    let dataMode = false;
    let data = "";
    const server = createServer((socket) => {
      socket.write("220 fake.test ESMTP\r\n");
      let step = 0;
      socket.on("data", (chunk: Buffer) => {
        if (dataMode) {
          data += chunk.toString("utf8");
          if (data.includes("\r\n.\r\n")) {
            dataMode = false;
            received.push(data);
            socket.write("250 ok\r\n");
          }
          return;
        }
        const line = chunk.toString("utf8");
        if (/^EHLO/i.test(line)) {
          step += 1;
          socket.write("250-fake\r\n250 AUTH LOGIN PLAIN\r\n");
        } else if (/^AUTH LOGIN/i.test(line)) {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (step === 1 && /^[A-Za-z0-9+/=]+\r\n$/.test(line)) {
          step += 1;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (step === 2 && /^[A-Za-z0-9+/=]+\r\n$/.test(line)) {
          step += 1;
          socket.write("235 ok\r\n");
        } else if (/^MAIL FROM/i.test(line)) {
          envelope.push(line.trim());
          socket.write("250 ok\r\n");
        } else if (/^RCPT TO/i.test(line)) {
          envelope.push(line.trim());
          socket.write("250 ok\r\n");
        } else if (/^DATA/i.test(line)) {
          dataMode = true;
          socket.write("354 end with .\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 bye\r\n");
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const provider = new SmtpEmailProvider({ host: "127.0.0.1", port, secure: false, username: "user", password: "pass", from: "noreply@example.com" });
      await provider.sendPasswordReset("reader@example.com", "https://app.example.com/#/recover?token=tok", Date.now() + 1000);
      expect(envelope).toContain("RCPT TO:<reader@example.com>");
      expect(received).toHaveLength(1);
      expect(received[0]).toMatch(/Subject: Reset your Live Edits password/);
      expect(received[0]).toContain("https://app.example.com/#/recover?token=tok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("saas server boot (M7.1)", () => {
  it("boots under plain node type-stripping with no build step", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["server/src/index.ts"], {
      env: {
        ...process.env,
        LIVE_EDITS_SAAS_PORT: "0",
        LIVE_EDITS_SAAS_HOST: "127.0.0.1",
        NODE_ENV: "test",
        LIVE_EDITS_STORAGE_DIR: mkdtempSync(join(tmpdir(), "saas-boot-")),
        LIVE_EDITS_SESSION_SECRET: "boot-secret-0123456789abcdef",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    try {
      const base = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("backend did not start: " + output)), 25000);
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const match = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      await health.arrayBuffer().catch(() => undefined);
    } finally {
      child.kill();
    }
  });
});

describe("saas session expiry (M7)", () => {
  it("rejects sessions past their TTL", async () => {
    process.env["LIVE_EDITS_SESSION_TTL_MS"] = "150";
    const storage = new FilesystemStorage(mkdtempSync(join(tmpdir(), "saas-exp-")));
    await storage.init();
    const app = createSaasApp({ store: new MemoryStore(), storage, secret: "exp-secret" });
    const { base } = await app.listen(0);
    try {
      const reg = await register(base, "ttl@example.com");
      expect((await api(base, "GET", "/api/auth/me", reg.token)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 350));
      expect((await api(base, "GET", "/api/auth/me", reg.token)).status).toBe(401);
    } finally {
      delete process.env["LIVE_EDITS_SESSION_TTL_MS"];
      await app.close();
    }
  });
});

describe("saas migrations and storage guards (M7)", () => {
  it("ships a Postgres migration covering every persisted entity", async () => {
    const sql = await readMigrationSql();
    for (const table of ["users", "password_resets", "sessions", "workspaces", "memberships", "packs", "effects", "assignments", "sequence_steps", "media", "overlay_sessions", "trigger_history", "audit_events"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    expect(sql).toMatch(/UNIQUE \(workspace_id, pack_uid\)/);
    expect(sql).toMatch(/UNIQUE \(workspace_id, name\)/);
    expect(sql).toMatch(/FOREIGN KEY|REFERENCES/);
  });

  it("validates filenames and sniffs content like the local relay", () => {
    expect(validMediaName("clip.wav")).toBe(true);
    expect(validMediaName("../evil.wav")).toBe(false);
    expect(validMediaName("a".repeat(129) + ".wav")).toBe(false);
    expect(validMediaName("clip.avi")).toBe(false);
    expect(kindForExt(".wav")).toBe("audio");
    expect(kindForExt(".webm")).toBe("video");
    expect(kindForExt(".png")).toBe("image");
    expect(kindForExt(".avi")).toBeNull();
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffKind(wav, ".wav")).toBe("audio");
    expect(sniffKind(wav, ".mp3")).toBeNull();
  });
});

describe("saas save/reload consistency (M7)", () => {
  it("packs and media survive a dashboard reload without reimport", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "rl@example.com");
      const ws = await createWorkspace(app.base, a.token, "Reload");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      const up = await fetch(`${app.base}/api/workspaces/${ws}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "audio/wav", "X-Filename": "clip.wav" },
        body: new Uint8Array(wavBytes(300)),
      });
      expect(up.status).toBe(201);
      await up.arrayBuffer().catch(() => undefined);
      await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });

      // "Reload": fresh reads, same server.
      const packs = await api(app.base, "GET", `/api/workspaces/${ws}/packs`, a.token);
      expect((packs.json as { packs: Array<{ packUid: string }> }).packs.map((p) => p.packUid)).toContain("pack-1");
      const media = await api(app.base, "GET", `/api/workspaces/${ws}/media`, a.token);
      expect((media.json as { media: Array<{ name: string }> }).media.map((m) => m.name)).toContain("clip.wav");
      const fire = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1" });
      expect(fire.status).toBe(202);
      expect((fire.json as { accepted: boolean }).accepted).toBe(true);
    } finally {
      await app.close();
    }
  });
});

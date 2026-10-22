import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * Password-recovery delivery. Recovery tokens are secrets: providers send
 * them out of band (email) and NEVER return them to API callers. The HTTP
 * layer only ever responds `{ ok: true }`.
 */
export interface EmailProvider {
  sendPasswordReset(to: string, resetUrl: string, expiresAt: number): Promise<void>;
}

export function resetUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#/recover?token=${encodeURIComponent(token)}`;
}

/** Development fallback: prints to the server log. Tokens stay server-side. */
export class LoggingEmailProvider implements EmailProvider {
  async sendPasswordReset(to: string, resetUrl: string, expiresAt: number): Promise<void> {
    console.log(
      `[saas-email] password reset for ${to} (expires ${new Date(expiresAt).toISOString()}): open ${resetUrl} — dev logging provider, token never leaves this log`
    );
  }
}

/** Test double: captures deliveries in memory for assertions. */
export class InMemoryEmailProvider implements EmailProvider {
  readonly sent: Array<{ to: string; resetUrl: string; expiresAt: number }> = [];
  async sendPasswordReset(to: string, resetUrl: string, expiresAt: number): Promise<void> {
    this.sent.push({ to, resetUrl, expiresAt });
  }
  tokenFor(to: string): string | null {
    const found = this.sent.find((s) => s.to === to);
    if (!found) return null;
    const match = /token=([^&]+)/.exec(found.resetUrl);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  timeoutMs?: number;
}

/**
 * Real SMTP delivery over raw sockets: EHLO, optional STARTTLS, AUTH
 * LOGIN/PLAIN, MAIL/RCPT/DATA, QUIT. No external dependencies.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly config: SmtpConfig;
  constructor(config: SmtpConfig) {
    this.config = config;
  }

  async sendPasswordReset(to: string, resetUrl: string, expiresAt: number): Promise<void> {
    const subject = "Reset your Live Edits password";
    const text =
      `Someone requested a password reset for this address.\n\n` +
      `Open this link before ${new Date(expiresAt).toISOString()} to choose a new password:\n${resetUrl}\n\n` +
      `If you did not request this, ignore this message.\n`;
    await this.sendMail(to, subject, text);
  }

  private async sendMail(to: string, subject: string, text: string): Promise<void> {
    const { host, port, secure, username, password, from, timeoutMs = 15000 } = this.config;
    let socket: Socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("smtp connect timeout")), timeoutMs);
      const connectFn = (secure ? tlsConnect : connect) as (port: number, host: string) => Socket;
      const sock = connectFn(port, host);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    try {
      const greeting = await this.readLine(socket, timeoutMs);
      expectCode(greeting, [220]);
      const caps = await this.command(socket, `EHLO live-edits\r\n`, timeoutMs, [250]);
      if (!secure && /STARTTLS/i.test(caps)) {
        await this.command(socket, "STARTTLS\r\n", timeoutMs, [220]);
        socket = await this.upgradeTls(socket, host, timeoutMs);
        await this.command(socket, `EHLO live-edits\r\n`, timeoutMs, [250]);
      }
      await this.command(socket, "AUTH LOGIN\r\n", timeoutMs, [334]);
      await this.command(socket, `${Buffer.from(username, "utf8").toString("base64")}\r\n`, timeoutMs, [334]);
      await this.command(socket, `${Buffer.from(password, "utf8").toString("base64")}\r\n`, timeoutMs, [235]);
      await this.command(socket, `MAIL FROM:<${from}>\r\n`, timeoutMs, [250]);
      await this.command(socket, `RCPT TO:<${to}>\r\n`, timeoutMs, [250, 251]);
      await this.command(socket, "DATA\r\n", timeoutMs, [354]);
      const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", ""].join("\r\n");
      await this.writeAll(socket, `${headers}${text}\r\n.\r\n`, timeoutMs);
      await this.readMultiline(socket, timeoutMs, [250]);
      await this.command(socket, "QUIT\r\n", timeoutMs, [221]);
    } finally {
      socket.destroy();
    }
  }

  private lineBuffers = new Map<Socket, string>();

  private writeAll(socket: Socket, data: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("smtp write timeout")), timeoutMs);
      socket.write(data, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private readLine(socket: Socket, timeoutMs: number): Promise<string> {
    const buffered = this.lineBuffers.get(socket) ?? "";
    const idx = buffered.indexOf("\r\n");
    if (idx >= 0) {
      this.lineBuffers.set(socket, buffered.slice(idx + 2));
      return Promise.resolve(buffered.slice(0, idx));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("data", onData);
        socket.off("error", onError);
        reject(new Error("smtp read timeout"));
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        try {
          const next = (this.lineBuffers.get(socket) ?? "") + chunk.toString("utf8");
          const at = next.indexOf("\r\n");
          if (at >= 0) {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            this.lineBuffers.set(socket, next.slice(at + 2));
            resolve(next.slice(0, at));
          } else {
            this.lineBuffers.set(socket, next);
          }
        } catch (e) {
          clearTimeout(timer);
          socket.off("data", onData);
          socket.off("error", onError);
          reject(e as Error);
        }
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        reject(err);
      };
      socket.on("data", onData);
      socket.once("error", onError);
    });
  }

  private async readMultiline(socket: Socket, timeoutMs: number, want: number[]): Promise<string> {
    let first = await this.readLine(socket, timeoutMs);
    let guard = 0;
    // Continuation lines end with "250 " (space); only the latest line decides.
    while (/^\d{3}-/.test(first.split("\n").pop() ?? "") && guard < 20) {
      guard += 1;
      first = `${first}\n${await this.readLine(socket, timeoutMs)}`;
    }
    expectCode(first, want);
    return first;
  }

  private async command(socket: Socket, cmd: string, timeoutMs: number, want: number[]): Promise<string> {
    await this.writeAll(socket, cmd, timeoutMs);
    return this.readMultiline(socket, timeoutMs, want);
  }

  private upgradeTls(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("smtp tls timeout")), timeoutMs);
      const tls = tlsConnect({ socket, servername: host });
      tls.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(tls);
      });
      tls.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

function expectCode(line: string, want: number[]): void {
  const code = Number(line.slice(0, 3));
  if (!want.includes(code)) throw new Error(`smtp unexpected reply: ${line}`);
}

export interface EmailEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  APP_BASE_URL?: string;
}

/** Fail-closed factory: production requires a real provider configuration. */
export function emailProviderFromEnv(env: NodeJS.ProcessEnv = process.env): { provider: EmailProvider; appBaseUrl: string } {
  const appBaseUrl = (env["APP_BASE_URL"] || "").trim();
  const host = (env["SMTP_HOST"] || "").trim();
  if (host) {
    const port = Number(env["SMTP_PORT"] || "587");
    const username = (env["SMTP_USER"] || "").trim();
    const password = env["SMTP_PASS"] ?? "";
    const from = (env["SMTP_FROM"] || "").trim();
    if (!Number.isInteger(port) || port <= 0) throw new Error("SMTP_PORT must be a positive integer.");
    if (!username || !password || !from) throw new Error("SMTP_HOST is set but SMTP_USER/SMTP_PASS/SMTP_FROM are incomplete.");
    return {
      provider: new SmtpEmailProvider({ host, port, secure: (env["SMTP_SECURE"] || "") === "1", username, password, from }),
      appBaseUrl,
    };
  }
  if ((env["NODE_ENV"] ?? "") === "production") {
    throw new Error("Refusing to start: production requires SMTP_HOST (+ SMTP_USER/SMTP_PASS/SMTP_FROM) for password recovery.");
  }
  return { provider: new LoggingEmailProvider(), appBaseUrl };
}

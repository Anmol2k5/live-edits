// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { SmtpEmailProvider } from "./email.ts";

const runNode = promisify(execFile);

async function startSmtpServer() {
  const plaintext: string[] = [];
  const encrypted: string[] = [];
  const messages: string[] = [];
  const connections = new Set<Socket>();
  const secureContext = createSecureContext({ key: testKey, cert: testCertificate });
  const server = createServer((raw) => {
    connections.add(raw);
    raw.on("close", () => connections.delete(raw));
    raw.on("error", () => undefined);
    let socket: Socket = raw;
    let buffer = "";
    let tls = false;
    let authStep = 0;
    let dataMode = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        (tls ? encrypted : plaintext).push(line);
        if (line.startsWith("EHLO")) {
          socket.write(tls ? "250 AUTH LOGIN\r\n" : "250-localhost\r\n250 STARTTLS\r\n");
        } else if (line === "STARTTLS") {
          raw.off("data", onData);
          raw.write("220 ready for TLS\r\n");
          const upgraded = new TLSSocket(raw, { isServer: true, secureContext });
          connections.add(upgraded);
          upgraded.on("close", () => connections.delete(upgraded));
          upgraded.on("error", () => undefined);
          socket = upgraded;
          tls = true;
          socket.on("data", onData);
        } else if (line === "AUTH LOGIN" || authStep === 1) {
          authStep += 1;
          socket.write("334 challenge\r\n");
        } else if (authStep === 2) {
          authStep = 3;
          socket.write("235 authenticated\r\n");
        } else if (/^(MAIL FROM|RCPT TO):/.test(line)) {
          socket.write("250 accepted\r\n");
        } else if (line === "DATA") {
          dataMode = true;
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        }
      }
    };
    raw.on("data", onData);
    raw.write("220 localhost ESMTP\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server has no port");
  return {
    config: { host: "localhost", port: address.port, secure: false, username: "smtp-user", password: "smtp-password", from: "noreply@example.com", timeoutMs: 1000 },
    plaintext,
    encrypted,
    messages,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SMTP STARTTLS", () => {
  it("delivers recovery mail over the upgraded TLS socket", async () => {
    const smtp = await startSmtpServer();
    const directory = await mkdtemp(join(tmpdir(), "live-edits-smtp-"));
    try {
      const certificatePath = join(directory, "ca.pem");
      await writeFile(certificatePath, testCertificate);
      // Node reads additional trust roots at startup. Keep verification enabled
      // and trust this fixture only in the child that sends this message.
      const source = `
        import { SmtpEmailProvider } from ${JSON.stringify(new URL("./email.ts", import.meta.url).href)};
        const provider = new SmtpEmailProvider(${JSON.stringify(smtp.config)});
        await provider.sendPasswordReset("reader@example.com", "https://app.example.com/#/recover?token=secret", Date.now() + 1000);
      `;
      await runNode(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath },
        timeout: 5000,
      });
      expect(smtp.plaintext).toEqual(["EHLO live-edits", "STARTTLS"]);
      expect(smtp.encrypted).toContain("EHLO live-edits");
      expect(smtp.encrypted).toContain("AUTH LOGIN");
      expect(smtp.encrypted).toContain("RCPT TO:<reader@example.com>");
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain("https://app.example.com/#/recover?token=secret");
    } finally {
      await smtp.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects untrusted TLS certificates before sending credentials", async () => {
    const smtp = await startSmtpServer();
    try {
      const provider = new SmtpEmailProvider(smtp.config);
      await expect(provider.sendPasswordReset("reader@example.com", "https://app.example.com/#/recover?token=secret", Date.now() + 1000))
        .rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      expect(smtp.plaintext).toEqual(["EHLO live-edits", "STARTTLS"]);
      expect(smtp.encrypted).toEqual([]);
      expect(smtp.messages).toEqual([]);
    } finally {
      await smtp.close();
    }
  });
});

// A public, test-only localhost key and self-signed certificate.
const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCxJI/Q67/myaxs
OWKQLPJJXAfNYBIUabNY7r1uxPNHV95Vx0gsWJfQv7FhMs8am50uGwOuoy9KKlLI
Q5GCsZEvnuq1rO5dis+UdardXOzO6mc8d0PC91JAyEqbjwV1I8QUNneJW+7q8FOK
IELOmSFovheggHmonSrPV89qOmXYqphDaNtlH5khj1ASiI00GDv333PpMbgjpf0y
H4WQGby0Cb3FdByiADYG0nBepS2BVg4gXpLEFHeJikxAlEvVKyegGrUmRhzh9KVh
yfL92G5UAcs4dzU8uhDqEzjo+57oThLh6DDjuFGu+pS9dSZZ6PZd+Yj99hu9wTTj
bc3sZPbTAgMBAAECggEAPCWycVlC6Q2MLpkThunEALWvboQSz3yOaYFyr8RO6GgE
9bI7JteUAMy94Ud7u8ifx5Jjny4IdhHF1vreUvaQ2g8HGdXUf82MqxeDAzO0spMz
p3vFddM9SgLYFlarHzmcL9LIpsqg5oPgkbNfi7/B8MsuwZAt/tsSuKFTq3mVsEm3
zGF7c/3/C+8V4vKlj7spZ7mAL55XBgT2M+V6fL5/UDVHcp0PiBbQMxTSxU/TMR8t
ZCAtcvUCCgw+zP+pSK1/OVXfpIcgxyi1yKTf4QVN7ugMpxpVUIyX/iTmPFa3tG3i
i1xnIS9VR9vmOv8ocUWQc3AlSbK4uwrk2onMr3cmmQKBgQDaq9sQ8NDOowxQnb5y
ANk9/peVpYpTFmiLIJ3k56MFC1qat99FZ+BdPuUoUVweaZQidZhrInQOStynW/c5
zawhKGVNzry5qkVDlJbvJO0yykkJ0CdB2r8NRIU1U44QloJ1a0L2ohqNImLcglJa
nC5PcxeceZQFdUT9VCFa8w/E+QKBgQDPYd8YBEvnKHO70+DK7KWvEpjanDssAlb/
+Fmd6t9lBV+YH0859JgTP0XB1csNUl4nqJ2+uMv72X0dZ13MlFuQdsOeFh61zzzJ
wZ5MYKgDaWUOGuTkdQzMqLbDgfOgeL4C86hkMEYg0ruCMkXrVTNjKaqP/tFdCw/s
GREhV4spKwKBgB2qcPbUZM+TySjqrZqTyOUjM/dmVOS+xoIRc7pJPpGBn9Ibndux
ovuje71DhGbP1fvyzjHCo9IIj/TYgirCX1bEPzIWGP5rPihT8UISVWetj8kYBytk
/MRVBmlco4pWkO5TFeuVxFpfTuAxgfCu/Y1jxNFCoTU4WpqvnjLThNEpAoGACv1j
xjEMGK7jGzQKOJa73QA+S292D0n8dEoj7aNxvTfArh4So76bhIGY38HFpeoUhUOB
QIcogCsxXyqIJPxDse8pRKplbDsUPJjfG6sPnEasjUfNk3HEgN/793Zeg8WCREPH
S6/nN3wTZb3mSKdWNs4RdNoLHEQmztsxNjQecssCgYEAsxZZmRFrUz77HDimM5jU
OM28QrD37VAZYXmCOl3CYE8VhS9XdL91feZDa43kGRTAmjTNc8Op8dv6H18Caj9K
oVjLEIebt1GIwAqOhURATk3VSdD63J1VHK/WPSEaL6J4r7+/VjcfqQQq57SmZmXP
EfbRRQ0fi2Sw1kBxqnpdNsA=
-----END PRIVATE KEY-----
`;
const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUW8RtFUWjoM4YbZqXvknn5ZRjafwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMTExNDUzOVoYDzIxMjYw
OTI3MTE0NTM5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCxJI/Q67/myaxsOWKQLPJJXAfNYBIUabNY7r1uxPNH
V95Vx0gsWJfQv7FhMs8am50uGwOuoy9KKlLIQ5GCsZEvnuq1rO5dis+UdardXOzO
6mc8d0PC91JAyEqbjwV1I8QUNneJW+7q8FOKIELOmSFovheggHmonSrPV89qOmXY
qphDaNtlH5khj1ASiI00GDv333PpMbgjpf0yH4WQGby0Cb3FdByiADYG0nBepS2B
Vg4gXpLEFHeJikxAlEvVKyegGrUmRhzh9KVhyfL92G5UAcs4dzU8uhDqEzjo+57o
ThLh6DDjuFGu+pS9dSZZ6PZd+Yj99hu9wTTjbc3sZPbTAgMBAAGjaTBnMB0GA1Ud
DgQWBBRGff0PtSiXvppzhvuibk952I/dQjAfBgNVHSMEGDAWgBRGff0PtSiXvppz
hvuibk952I/dQjAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEAhvl84KQX5Ur69+VepbMCkI/9fPNpKUm4i4nE
C1iV8foBwjo1YYYFlItEUPgVDSdUnlm/H04IUfSPkAgGNpUk+vdoWbAgbQhf58bt
lPQQeMbmw8jClh+YxbE9dCrKixsCbE+WU52CJIfqV+BcGyOCRtJMSVx7Dgr2Xs5w
Wuj2vlb46o8zphczEjNHN82bdC3lNuirHDm3Uhtjv/LSGZRJEdiNUd3yvAEES8fw
/y6kLrQkEESyevPaMJhZ3SV0WeOOAPwH37BW1XWB5vp7mJqLS9rZDsipBdSzXUJ0
LCsdhkRL5GtCOyWpzFwMeg7t1sWhd9u9sNlowS0Foxa717iB2Q==
-----END CERTIFICATE-----
`;

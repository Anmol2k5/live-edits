import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SaasBackend {
  base: string;
  stop: () => Promise<void>;
}

/** Start the real SaaS backend (no mocks) on an ephemeral port for e2e. */
export async function startSaasBackend(): Promise<SaasBackend> {
  const storageDir = mkdtempSync(join(tmpdir(), "saas-e2e-media-"));
  const child: ChildProcess = spawn(
    process.execPath,
    ["server/src/index.ts"],
    {
      env: {
        ...process.env,
        LIVE_EDITS_SAAS_PORT: "0",
        LIVE_EDITS_SAAS_HOST: "127.0.0.1",
        LIVE_EDITS_STORAGE_DIR: storageDir,
        LIVE_EDITS_SESSION_SECRET: "e2e-secret-0123456789abcdef",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("saas backend did not start: " + output)), 30000);
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
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`saas backend exited ${code}: ${output}`));
      }
    });
  });
  // Wait for health.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // starting
    }
    if (Date.now() > deadline) throw new Error("saas backend unhealthy: " + output);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    stop: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

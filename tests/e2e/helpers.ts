import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { createOverlayRelay } from "../../scripts/overlay-relay.mjs";

export const PUBLISH_TOKEN = "e2e-publish-token";
export const VIEW_TOKEN = "e2e-view-token";

/** 0.6s 440Hz sine, 16-bit PCM mono — decodes everywhere, no licensing issues. */
export function makeWav(path: string): void {
  const rate = 22050;
  const seconds = 0.6;
  const frames = Math.floor(rate * seconds);
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / rate);
    data.writeInt16LE(Math.floor(sample * 16000), 44 + i * 2);
  }
  writeFileSync(path, data);
}

/**
 * Self-generated WebM: an animated canvas recorded with MediaRecorder in
 * the same browser that later plays it back. No binaries committed, no
 * copyrighted samples, guaranteed-supported codec path (vp8 or default).
 * Retries a few times: encoder cold-starts occasionally yield empty output.
 */
export async function makeWebm(browser: Browser, path: string): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<canvas id="c" width="160" height="120"></canvas>
       <script>
         const canvas = document.getElementById("c");
         const ctx = canvas.getContext("2d");
         let frame = 0;
         setInterval(() => {
           frame += 1;
           ctx.fillStyle = frame % 2 ? "#ff6b35" : "#4a90d9";
           ctx.fillRect(0, 0, 160, 120);
           ctx.fillStyle = "#fff";
           ctx.fillRect((frame * 7) % 120, 40, 40, 40);
         }, 33);
       </script>`
    );
    let lastBytes = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const bytes = await page.evaluate(async () => {
        const canvas = document.getElementById("c") as HTMLCanvasElement;
        const stream = canvas.captureStream(30);
        const candidates = [
          "video/webm;codecs=vp8",
          "video/webm;codecs=vp9",
          "video/webm",
        ];
        const mimeType =
          candidates.find((c) => window.MediaRecorder.isTypeSupported(c)) ?? "";
        const recorder = mimeType
          ? new window.MediaRecorder(stream, { mimeType })
          : new window.MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        const done = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
        });
        recorder.start(100);
        await new Promise((r) => setTimeout(r, 1200));
        recorder.stop();
        await done;
        // The final chunk can land just after onstop; yield one turn.
        await new Promise((r) => setTimeout(r, 100));
        const blob = new Blob(chunks, { type: "video/webm" });
        const buffer = await blob.arrayBuffer();
        const view = new Uint8Array(buffer);
        const out: number[] = new Array(view.length);
        for (let i = 0; i < view.length; i += 1) out[i] = view[i] ?? 0;
        return out;
      });
      lastBytes = bytes.length;
      if (bytes.length > 2000) {
        writeFileSync(path, Buffer.from(bytes));
        return;
      }
    }
    throw new Error(
      `Could not record a valid WebM fixture after retries (last ${lastBytes} bytes).`
    );
  } finally {
    await page.close();
  }
}

export interface RelayHandle {
  base: string;
  port: number;
  close: () => Promise<void>;
}

export async function startRelay(mediaDirectory: string): Promise<RelayHandle> {
  const relay = createOverlayRelay({
    publishToken: PUBLISH_TOKEN,
    viewToken: VIEW_TOKEN,
    mediaDirectory,
  });
  const address = await relay.listen(0);
  const port =
    typeof address === "object" && address !== null ? address.port : 4190;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => relay.close(),
  };
}

export function overlayUrl(base: string): string {
  return `${base}/overlay?token=${VIEW_TOKEN}&debug=1`;
}

export async function publish(
  base: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}/api/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PUBLISH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

export function makeMediaDir(): string {
  return mkdtempSync(join(tmpdir(), "live-edits-e2e-"));
}

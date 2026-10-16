import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import {
  makeWav,
  makeMediaDir,
  startRelay,
  overlayUrl,
  PUBLISH_TOKEN,
  type RelayHandle,
} from "./helpers";

let browser: Browser;
let relay: RelayHandle;
let mediaDir: string;
let wavPath: string;

test.setTimeout(90000);

test.beforeAll(async () => {
  browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--disable-dev-shm-usage",
    ],
  });
  mediaDir = makeMediaDir();
  wavPath = join(mediaDir, "sting.wav");
  makeWav(wavPath);
  relay = await startRelay(mediaDir);
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await relay?.close().catch(() => undefined);
});

/**
 * Full M6 workflow in a real browser: build a pack in the editor with no
 * webcam, fire the configured effect, and watch the actual OBS overlay
 * play the same media. The desktop UI under test is served by `vite dev`
 * (see webServer in playwright.config.ts).
 */
test("editor-built audio effect plays on the OBS overlay", async () => {
  const app = await browser.newPage();
  try {
    await app.goto("http://localhost:1420/", { waitUntil: "networkidle" });

    // Paste the relay publish token while in Live view (the OBS Bridge
    // panel starts collapsed). The base URL is configurable because test
    // relays listen on ephemeral ports.
    await app.getByText(/OBS Bridge/).click();
    await app.getByLabel(/relay base url/i).fill(relay.base);
    await app.getByLabel(/publish token/i).fill(PUBLISH_TOKEN);

    // Build the pack in the Editor tab — no webcam involved.
    await app.getByRole("button", { name: "Editor", exact: true }).click();
    await app.getByLabel("New pack name").fill("E2E Pack");
    await app.getByRole("button", { name: "Create", exact: true }).click();
    await expect(app.getByRole("option", { name: "E2E Pack" })).toBeAttached();

    await app.getByLabel("Import media files").setInputFiles(wavPath);
    await expect(app.getByText("sting.wav")).toBeAttached();
    await app.getByLabel("New effect kind").selectOption("audio");
    await app.getByRole("button", { name: "Create effect" }).click();
    await expect(app.getByRole("button", { name: /\(audio\)/ })).toBeAttached();

    // Persist and activate so live triggers resolve through this pack.
    await app.getByRole("button", { name: /^Save/ }).click();
    await expect(app.getByText("Saved")).toBeAttached();
    await app.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(app.getByText("Saved · active")).toBeAttached();

    // The real overlay must be connected BEFORE firing: the relay
    // broadcasts live and does not persist triggers for late joiners.
    const overlay: Page = await browser.newPage();
    try {
      await overlay.goto(overlayUrl(relay.base));
      const deadline = Date.now() + 20000;
      for (;;) {
        try {
          const health = (await (
            await fetch(`${relay.base}/api/health`)
          ).json()) as { connectedOverlays?: number };
          if ((health.connectedOverlays ?? 0) >= 1) break;
        } catch {
          // Half-bound relay port during startup: retry.
        }
        if (Date.now() > deadline) throw new Error("overlay did not connect");
        await overlay.waitForTimeout(250);
      }

      // Fire the saved effect straight at the relay.
      await app.bringToFront();
      await app.getByRole("button", { name: "Fire to OBS" }).click();
      // The desktop leg must confirm delivery before the overlay is checked
      // (status lives in the Live view's bridge panel).
      await app.getByRole("button", { name: "Live", exact: true }).click();
      await expect(app.getByText(/Reaction sent to 1 OBS overlay/)).toBeAttached({
        timeout: 15000,
      });
      await app.getByRole("button", { name: "Editor", exact: true }).click();

      const audio = overlay.locator("#stage audio");
      await expect(audio).toBeAttached({ timeout: 15000 });
      expect(await audio.getAttribute("src")).toContain("/media/sting.wav");
      await overlay.waitForFunction(
        () => {
          const el = document.querySelector("#stage audio") as HTMLAudioElement | null;
          return el !== null && !el.paused;
        },
        { timeout: 15000 }
      );
      await overlay.waitForFunction(
        () =>
          (window as unknown as { __liveEdits?: { idle: () => boolean } }).__liveEdits?.idle() ===
          true,
        { timeout: 30000 }
      );
    } finally {
      await overlay.close();
    }

    // Reload proves save/reload integrity: the pack (and its effect) persist
    // in localStorage while session media needs a reimport.
    await app.reload({ waitUntil: "networkidle" });
    await app.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(app.getByRole("option", { name: "E2E Pack" })).toBeAttached();
    await expect(app.getByRole("button", { name: /\(audio\)/ })).toBeAttached();
  } finally {
    await app.close();
  }
});

test("editor pack media must exist on the relay or publish is rejected", async () => {
  // The relay validates filenames against its own directory: a pack that
  // references a file the relay never received gets a 400, never a
  // silent no-op.
  const response = await fetch(`${relay.base}/api/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PUBLISH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      moment: "wow",
      templateId: "wow-1",
      mediaFile: "ghost-clip.webm",
    }),
  });
  expect(response.status).toBe(400);
  await response.arrayBuffer().catch(() => undefined);
});

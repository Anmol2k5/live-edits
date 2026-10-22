import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import {
  makeWav,
  makeWebm,
  makeMediaDir,
  startRelay,
  overlayUrl,
  publish,
  type RelayHandle,
} from "./helpers";

let browser: Browser;
let relay: RelayHandle;
let mediaDir: string;

test.setTimeout(90000);

test.beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    // NOTE: no --autoplay-policy flag here — this project runs the stock
    // browser policy on purpose.
    args: ["--no-sandbox", "--mute-audio", "--disable-dev-shm-usage"],
  });
  mediaDir = makeMediaDir();
  const { join } = await import("node:path");
  makeWav(join(mediaDir, "sting.wav"));
  await makeWebm(browser, join(mediaDir, "clip.webm"));
  relay = await startRelay(mediaDir);
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await relay?.close().catch(() => undefined);
});

async function overlayPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(overlayUrl(relay.base));
  await expect(page.locator("#stage")).toBeAttached();
  return page;
}

async function waitIdle(page: Page, timeout = 30000): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __liveEdits?: { idle: () => boolean } }).__liveEdits?.idle() ===
      true,
    { timeout }
  );
}

test("video with sound degrades gracefully when autoplay is refused", async () => {
  const page = await overlayPage();
  try {
    expect((await publish(relay.base, {
      moment: "wow", templateId: "wow-1", mediaFile: "clip.webm",
      durationMs: 1200, volume: 0.8, cooldownMs: 0,
    })).status).toBe(202);
    // Either the refusal status appears or the element plays muted-by-policy
    // and still cleans up — but the stage must ALWAYS return to idle.
    await waitIdle(page, 30000);
    expect(await page.locator("#stage").innerHTML()).toBe("");
    // No crash, no stuck frame, no malformed-event noise.
    const status = await page.locator("#debug").textContent();
    expect(status ?? "").not.toMatch(/malformed/i);
  } finally {
    await page.close();
  }
});

test("image reactions still complete under the default policy", async () => {
  const page = await overlayPage();
  try {
    expect((await publish(relay.base, {
      moment: "funny", templateId: "funny-1", durationMs: 400, cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator("#stage img")).toBeAttached({ timeout: 10000 });
    await waitIdle(page, 30000);
    expect(await page.locator("#stage").innerHTML()).toBe("");
  } finally {
    await page.close();
  }
});

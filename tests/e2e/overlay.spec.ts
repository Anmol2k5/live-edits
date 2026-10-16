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
    channel: "chrome",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--disable-dev-shm-usage",
    ],
  });
  mediaDir = makeMediaDir();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  makeWav(join(mediaDir, "sting.wav"));
  await makeWebm(browser, join(mediaDir, "clip.webm"));
  writeFileSync(join(mediaDir, "notes.txt"), "not media");
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

test("video loads, plays, seeks and finishes with resource disposal", async () => {
  const page = await overlayPage();
  try {
    const posted = await publish(relay.base, {
      moment: "wow",
      templateId: "wow-1",
      mediaFile: "clip.webm",
      durationMs: 2500,
      volume: 0.4,
      cooldownMs: 0,
    });
    expect(posted.status).toBe(202);

    const video = page.locator("#stage video");
    await expect(video).toBeAttached({ timeout: 10000 });
    expect(await video.getAttribute("src")).toContain("/media/clip.webm");
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#stage video") as HTMLVideoElement | null;
        return el !== null && el.readyState >= 2 && el.volume === 0.4 && !el.paused;
      },
      { timeout: 15000 }
    );
    const before = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await page.waitForFunction(
      (start: number) => {
        const el = document.querySelector("#stage video") as HTMLVideoElement | null;
        return el !== null && el.currentTime > start + 0.1;
      },
      before,
      { timeout: 10000 }
    );
    // Seek to the midpoint and confirm the frame follows.
    await video.evaluate((el: HTMLVideoElement) => {
      el.currentTime = Math.min(0.5, (el.duration || 1) / 2);
    });
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#stage video") as HTMLVideoElement | null;
        return el !== null && el.currentTime >= 0.2;
      },
      { timeout: 10000 }
    );
    await waitIdle(page);
    expect(await page.locator("#stage video").count()).toBe(0);
    expect(await page.locator("#stage [src]").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("audio volume and playback with template fallback art", async () => {
  const page = await overlayPage();
  try {
    const posted = await publish(relay.base, {
      moment: "sad",
      templateId: "sad-1",
      mediaFile: "sting.wav",
      durationMs: 1200,
      volume: 0.7,
      cooldownMs: 0,
    });
    expect(posted.status).toBe(202);
    const audio = page.locator("#stage audio");
    await expect(audio).toBeAttached({ timeout: 10000 });
    expect(await audio.getAttribute("src")).toContain("/media/sting.wav");
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#stage audio") as HTMLAudioElement | null;
        return el !== null && el.volume === 0.7 && !el.paused;
      },
      { timeout: 15000 }
    );
    expect(await page.locator('#stage img[alt="sad reaction"]').count()).toBe(1);
    await waitIdle(page);
    expect(await page.locator("#stage audio").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("idle overlay stays transparent", async () => {
  const page = await overlayPage();
  try {
    await expect(page.locator("#stage")).toBeEmpty({ timeout: 5000 });
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    expect(background).toBe("rgba(0, 0, 0, 0)");
  } finally {
    await page.close();
  }
});

test("consecutive queued effects complete in priority order", async () => {
  const page = await overlayPage();
  try {
    const seen: string[] = [];
    await page.exposeFunction("recordAlt", (alt: string) => {
      if (seen[seen.length - 1] !== alt) seen.push(alt);
    });
    await page.evaluate(() => {
      const record = (window as unknown as { recordAlt: (alt: string) => void }).recordAlt;
      const timer = setInterval(() => {
        const img = document.querySelector("#stage img");
        if (img) void record(img.getAttribute("alt") ?? "?");
        if ((window as unknown as { __stopRecord?: boolean }).__stopRecord) {
          clearInterval(timer);
        }
      }, 60);
    });
    // Long low-priority effect starts first; higher priorities jump the queue.
    expect((await publish(relay.base, {
      moment: "wow", templateId: "wow-1", durationMs: 1200,
      queue: "queue", priority: 10, cooldownMs: 0,
    })).status).toBe(202);
    expect((await publish(relay.base, {
      moment: "sad", templateId: "sad-1", durationMs: 300,
      queue: "queue", priority: 50, cooldownMs: 0,
    })).status).toBe(202);
    expect((await publish(relay.base, {
      moment: "funny", templateId: "funny-1", durationMs: 300,
      queue: "queue", priority: 90, cooldownMs: 0,
    })).status).toBe(202);
    await waitIdle(page, 30000);
    await page.evaluate(() => {
      (window as unknown as { __stopRecord?: boolean }).__stopRecord = true;
    });
    expect(seen).toEqual(["wow reaction", "funny reaction", "sad reaction"]);
  } finally {
    await page.close();
  }
});

test("coexist layers pile up and release without residue", async () => {
  const page = await overlayPage();
  try {
    for (let i = 0; i < 10; i += 1) {
      const posted = await publish(relay.base, {
        moment: "wow",
        templateId: "wow-1",
        durationMs: 250,
        queue: "coexist",
        cooldownMs: 0,
        triggerId: `coexist-${i}`,
      });
      expect(posted.status).toBe(202);
    }
    await waitIdle(page, 30000);
    const layers = await page.evaluate(
      () =>
        (window as unknown as { __liveEdits: { layers: () => number } }).__liveEdits.layers()
    );
    expect(layers).toBe(0);
    expect(await page.locator("#stage").innerHTML()).toBe("");
  } finally {
    await page.close();
  }
});

test("replace interrupts the playing effect", async () => {
  const page = await overlayPage();
  try {
    expect((await publish(relay.base, {
      moment: "wow", templateId: "wow-1", durationMs: 8000,
      queue: "queue", cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator('#stage img[alt="wow reaction"]')).toBeAttached({
      timeout: 10000,
    });
    expect((await publish(relay.base, {
      moment: "sad", templateId: "sad-1", durationMs: 300,
      queue: "replace", cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator('#stage img[alt="sad reaction"]')).toBeAttached({
      timeout: 10000,
    });
    await waitIdle(page, 30000);
    expect(await page.locator('#stage img[alt="wow reaction"]').count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("malformed and expired triggers never reach the stage", async () => {
  const page = await overlayPage();
  try {
    expect((await publish(relay.base, { moment: "wow", templateId: "sad-1" })).status).toBe(
      400
    );
    expect(
      (await publish(relay.base, { moment: "wow", expiresAt: Date.now() - 1000 })).status
    ).toBe(400);
    expect(
      (await publish(relay.base, { moment: "wow", mediaFile: "notes.txt" })).status
    ).toBe(400);
    await page.waitForTimeout(500);
    expect(await page.locator("#stage").innerHTML()).toBe("");
    expect((await publish(relay.base, {
      moment: "wow", templateId: "wow-2", durationMs: 300, cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator("#stage img")).toBeAttached({ timeout: 10000 });
    await waitIdle(page);
  } finally {
    await page.close();
  }
});

test("reconnects after a relay restart on the same port", async () => {
  const page = await overlayPage();
  try {
    expect((await publish(relay.base, {
      moment: "wow", templateId: "wow-1", durationMs: 400, cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator("#stage img")).toBeAttached({ timeout: 10000 });
    await waitIdle(page, 30000);

    const port = relay.port;
    await relay.close();
    // Rebind the same port so the overlay's EventSource reconnect lands here.
    let rebound: RelayHandle | null = null;
    const { createOverlayRelay } = await import("../../scripts/overlay-relay.mjs");
    const { PUBLISH_TOKEN, VIEW_TOKEN } = await import("./helpers.js");
    for (let attempt = 0; attempt < 10 && !rebound; attempt += 1) {
      try {
        const fresh = createOverlayRelay({
          publishToken: PUBLISH_TOKEN,
          viewToken: VIEW_TOKEN,
          mediaDirectory: mediaDir,
        });
        const address = await fresh.listen(port);
        const bound =
          typeof address === "object" && address !== null ? address.port : port;
        if (bound !== port) {
          await fresh.close();
          await page.waitForTimeout(300);
          continue;
        }
        rebound = { base: `http://127.0.0.1:${bound}`, port: bound, close: () => fresh.close() };
      } catch {
        await page.waitForTimeout(300);
      }
    }
    expect(rebound, "relay rebound to the same port").not.toBeNull();
    relay = rebound as RelayHandle;

    // The overlay's EventSource must reattach before anything published
    // can be delivered: triggers are broadcast, not persisted.
    const deadline = Date.now() + 20000;
    for (;;) {
      const health = await (
        await fetch(`${relay.base}/api/health`)
      ).json() as { connectedOverlays?: number };
      if ((health.connectedOverlays ?? 0) >= 1) break;
      if (Date.now() > deadline) throw new Error("overlay did not reconnect");
      await page.waitForTimeout(250);
    }

    expect((await publish(relay.base, {
      moment: "funny", templateId: "funny-1", durationMs: 400, cooldownMs: 0,
    })).status).toBe(202);
    await expect(page.locator('#stage img[alt="funny reaction"]')).toBeAttached({
      timeout: 20000,
    });
    await waitIdle(page, 30000);
  } finally {
    await page.close();
  }
});

test("soak: fifty mixed effects stay stable with bounded heap", async () => {
  const page = await overlayPage();
  try {
    const heapBefore = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
          ?.usedJSHeapSize ?? null
    );
    const kinds = ["wow-1", "funny-1", "sad-1", "wow-2", "funny-2", "sad-2"];
    for (let i = 0; i < 50; i += 1) {
      const templateId = kinds[i % kinds.length] as string;
      const useMedia = i % 5 === 0;
      const posted = await publish(relay.base, {
        moment: templateId.split("-")[0],
        templateId,
        ...(useMedia ? { mediaFile: i % 10 === 0 ? "clip.webm" : "sting.wav" } : {}),
        durationMs: 250 + (i % 4) * 50,
        queue: i % 7 === 0 ? "coexist" : "queue",
        cooldownMs: 0,
        triggerId: `soak-${i}`,
      });
      expect(posted.status).toBe(202);
    }
    await waitIdle(page, 90000);
    const heapAfter = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
          ?.usedJSHeapSize ?? null
    );
    expect(await page.locator("#stage").innerHTML()).toBe("");
    if (heapBefore !== null && heapAfter !== null) {
      const growthMB = (heapAfter - heapBefore) / 1024 / 1024;
      expect(growthMB).toBeLessThan(30);
    }
    const status = await page.locator("#debug").textContent();
    expect(status ?? "").not.toMatch(/malformed/i);
  } finally {
    await page.close();
  }
});

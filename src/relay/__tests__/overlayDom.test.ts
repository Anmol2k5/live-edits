import { describe, it, expect } from "vitest";
import { JSDOM, type DOMWindow } from "jsdom";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedOverlayHtml } from "../../../server/src/overlays";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = resolve(HERE, "../../../public/obs-overlay.html");
const CORE_PATH = resolve(HERE, "../../effects/scheduler-core.js");

interface MockSource {
  url: string;
  handlers: Map<string, Array<(e: { data: string }) => void>>;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  emit: (name: string, data: unknown) => void;
}

class MockEventSource {
  handlers = new Map<string, Array<(e: { data: string }) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  emit: (name: string, data: unknown) => void = () => undefined;
  constructor(public url: string) {
    const self: MockSource = {
      url,
      handlers: this.handlers,
      onopen: null,
      onerror: null,
      emit: (name, data) => {
        for (const fn of this.handlers.get(name) ?? []) {
          fn({ data: JSON.stringify(data) });
        }
      },
    };
    self.emit = (name: string, data: unknown) => {
      for (const fn of this.handlers.get(name) ?? []) {
        fn({ data: JSON.stringify(data) });
      }
    };
    MockEventSource.latest = self;
  }
  static latest: MockSource | null = null;
  addEventListener(name: string, fn: (e: { data: string }) => void): void {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }
}

function requireSource(): MockSource {
  const current = MockEventSource.latest;
  if (!current) throw new Error("Overlay did not construct an EventSource");
  return current;
}

async function mountPlayer(playMedia?: (media: HTMLMediaElement) => Promise<void>, hosted = false) {
  const [html, core] = await Promise.all([
    hosted ? hostedOverlayHtml("test-overlay") : readFile(OVERLAY_PATH, "utf8"),
    readFile(CORE_PATH, "utf8"),
  ]);
  // Mirror what the relay serves: the shared core as a classic script ahead
  // of the inline player (no network in this harness).
  const bundled = html.replace(
    hosted ? '<script src="/o/test-overlay/scheduler-core.js"></script>' : '<script src="/obs-player.js"></script>',
    `<script>${core}</script>`
  );
  MockEventSource.latest = null;
  const played: string[] = [];
  const playback: Array<{ media: HTMLMediaElement; currentTime: number; muted: boolean }> = [];
  const paused: HTMLMediaElement[] = [];
  const dom = new JSDOM(bundled, {
    url: "http://127.0.0.1:4190/overlay?token=t",
    runScripts: "dangerously",
    beforeParse(window: DOMWindow) {
      (window as unknown as Record<string, unknown>).EventSource =
        MockEventSource as unknown;
      window.HTMLMediaElement.prototype.play = async function play(
        this: HTMLMediaElement
      ): Promise<void> {
        played.push(this.tagName);
        playback.push({ media: this, currentTime: this.currentTime, muted: this.muted });
        await playMedia?.(this);
      };
      window.HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
        paused.push(this);
      };
      window.HTMLMediaElement.prototype.load = function load() {};
    },
  });
  const { window } = dom;
  const document = window.document;
  const fireLoad = (): void => {
    for (const img of Array.from(
      document.querySelectorAll("img")
    ) as HTMLImageElement[]) {
      img.dispatchEvent(new window.Event("load"));
    }
  };
  const waitFor = async (
    cond: () => boolean,
    timeoutMs = 3000,
    label = "condition"
  ): Promise<void> => {
    const start = Date.now();
    for (;;) {
      if (cond()) return;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 10));
      fireLoad();
    }
  };
  const source = requireSource();
  return { window, document, source, played, playback, paused, waitFor, fireLoad, dom };
}

function reaction(overrides: Record<string, unknown> = {}) {
  return {
    moment: "wow",
    templateId: "wow-1",
    mediaFile: null,
    durationMs: 60,
    volume: 1,
    clipStartMs: null,
    clipEndMs: null,
    position: "center",
    queue: "replace",
    priority: 50,
    bootId: "boot-1",
    sequence: 1,
    at: Date.now(),
    ...overrides,
  };
}

describe.each(["local", "hosted"])("%s OBS overlay player (jsdom browser engine)", (variant) => {
  const mountOverlay = (playMedia?: (media: HTMLMediaElement) => Promise<void>) =>
    mountPlayer(playMedia, variant === "hosted");
  it("starts transparent and idle", async () => {
    const { document, window, dom } = await mountOverlay();
    try {
      expect(document.getElementById("stage")?.childElementCount).toBe(0);
      expect(window.getComputedStyle(document.body).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)"
      );
    } finally {
      dom.window.close();
    }
  });

  it("shows an image reaction then cleans up", async () => {
    const { document, source, waitFor, dom } = await mountOverlay();
    try {
      source.emit("reaction", reaction({ sequence: 1 }));
      await waitFor(
        () => document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "image appears"
      );
      await waitFor(
        () => document.getElementById("stage")?.childElementCount === 0,
        5000,
        "stage returns to idle"
      );
    } finally {
      dom.window.close();
    }
  });

  it("plays a video reaction and releases its source", async () => {
    const { document, source, played, waitFor, dom } = await mountOverlay();
    try {
      source.emit(
        "reaction",
        reaction({ sequence: 1, mediaFile: "clip.webm", durationMs: 80 })
      );
      await waitFor(() => document.querySelector("#stage video") !== null, 3000, "video appears");
      const video = document.querySelector("#stage video") as HTMLVideoElement;
      expect(video.src).toContain("/media/clip.webm");
      expect(played).toContain("VIDEO");
      await waitFor(
        () => document.getElementById("stage")?.childElementCount === 0,
        5000,
        "video cleaned up"
      );
      expect(video.getAttribute("src")).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("plays an audio reaction with a template fallback", async () => {
    const { document, source, played, waitFor, dom } = await mountOverlay();
    try {
      source.emit(
        "reaction",
        reaction({ sequence: 1, mediaFile: "sting.mp3", durationMs: 80 })
      );
      await waitFor(() => document.querySelector("#stage audio") !== null, 3000, "audio appears");
      expect(document.querySelector('#stage img[alt="wow reaction"]')).not.toBeNull();
      expect(played).toContain("AUDIO");
      await waitFor(
        () => document.getElementById("stage")?.childElementCount === 0,
        5000,
        "audio cleaned up"
      );
    } finally {
      dom.window.close();
    }
  });

  it.each([
    ["replace", "clip.webm"], ["coexist", "clip.webm"],
    ["replace", "sting.mp3"], ["coexist", "sting.mp3"],
  ])("seeks trimmed %s %s after metadata and before playback", async (queue, mediaFile) => {
    const { document, source, playback, window, waitFor, dom } = await mountOverlay();
    try {
      if (queue === "coexist") {
        source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      }
      source.emit("reaction", reaction({
        sequence: 2, mediaFile, durationMs: 2000, queue,
        clipStartMs: 1200, clipEndMs: 1280,
      }));
      const video = document.querySelector("#stage video,#stage audio") as HTMLMediaElement;
      expect(video).not.toBeNull();
      expect(playback).toHaveLength(0);
      Object.defineProperty(video, "readyState", { value: 1 });
      video.dispatchEvent(new window.Event("loadedmetadata"));
      await waitFor(() => playback.length === 1);
      expect(playback[0].currentTime).toBe(1.2);
      await waitFor(() => !video.isConnected, 700, "trimmed video ends");
    } finally {
      dom.window.close();
    }
  });

  it.each(["replace", "coexist"])("applies end-only trim to %s media", async (queue) => {
    const { document, source, waitFor, dom } = await mountOverlay();
    try {
      if (queue === "coexist") {
        source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      }
      source.emit("reaction", reaction({
        sequence: 2, mediaFile: "sting.mp3", durationMs: 2000, clipEndMs: 80, queue,
      }));
      const audio = document.querySelector("#stage audio") as HTMLAudioElement;
      await waitFor(() => !audio.isConnected, 700, "end-only trim removes audio");
    } finally {
      dom.window.close();
    }
  });

  it.each(["replace", "coexist"])("pauses trimmed %s audio at the start of its exit animation", async (queue) => {
    const { document, source, paused, waitFor, dom } = await mountOverlay();
    try {
      if (queue === "coexist") source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      source.emit("reaction", reaction({
        sequence: 2, mediaFile: "sting.mp3", durationMs: 2000, clipEndMs: 80, queue,
      }));
      const audio = document.querySelector("#stage audio") as HTMLAudioElement;
      await waitFor(() => audio.parentElement?.classList.contains("effect--leaving") === true, 500);
      expect(audio.isConnected).toBe(true);
      expect(paused).toContain(audio);
    } finally {
      dom.window.close();
    }
  });

  it.each(["clip.webm", "sting.mp3"])("honors muted for main and coexist %s", async (mediaFile) => {
    const { source, playback, waitFor, dom } = await mountOverlay();
    try {
      source.emit("reaction", reaction({ sequence: 1, mediaFile, durationMs: 2000, muted: true, volume: 0.25 }));
      source.emit("reaction", reaction({ sequence: 2, mediaFile, durationMs: 2000, queue: "coexist", muted: true, volume: 0.25 }));
      await waitFor(() => playback.length === 2);
      expect(playback.map((entry) => entry.muted)).toEqual([true, true]);
    } finally {
      dom.window.close();
    }
  });

  it.each(["clip.webm", "sting.mp3"])("honors volume for main and coexist %s", async (mediaFile) => {
    const { source, playback, waitFor, dom } = await mountOverlay();
    try {
      source.emit("reaction", reaction({ sequence: 1, mediaFile, durationMs: 2000, volume: 0.25 }));
      source.emit("reaction", reaction({ sequence: 2, mediaFile, durationMs: 2000, queue: "coexist", volume: 0.25 }));
      await waitFor(() => playback.length === 2);
      expect(playback.map((entry) => entry.media.volume)).toEqual([0.25, 0.25]);
    } finally {
      dom.window.close();
    }
  });

  it.each([null, "sting.mp3"])("uses template artwork for coexist %s", async (mediaFile) => {
    const { document, source, dom } = await mountOverlay();
    try {
      source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      source.emit("reaction", reaction({ sequence: 2, mediaFile, durationMs: 2000, queue: "coexist" }));
      const images = Array.from(document.querySelectorAll("#stage img"));
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(new URL((image as HTMLImageElement).src).pathname).toMatch(/\/templates\/wow-1\.png$/);
      }
    } finally {
      dom.window.close();
    }
  });

  it("does not start an image removed before its load completes", async () => {
    const { document, source, window, dom } = await mountOverlay();
    let tones = 0;
    (window as unknown as Record<string, unknown>).AudioContext = class {
      constructor() { tones += 1; }
    };
    try {
      source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      const image = document.querySelector("#stage img") as HTMLImageElement;
      source.emit("reaction", reaction({ sequence: 2, mediaFile: "clip.webm", durationMs: 2000 }));
      expect(image.isConnected).toBe(false);
      image.dispatchEvent(new window.Event("load"));
      expect(tones).toBe(0);
    } finally {
      dom.window.close();
    }
  });

  it.each(["replace", "coexist"])("does not restart %s video removed while awaiting metadata", async (queue) => {
    const { document, source, playback, window, dom } = await mountOverlay();
    try {
      if (queue === "coexist") source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      source.emit("reaction", reaction({
        sequence: 2, mediaFile: "clip.webm", durationMs: 2000, clipStartMs: 1200, queue,
      }));
      const video = document.querySelector("#stage video") as HTMLVideoElement;
      source.emit("reaction", reaction({ sequence: 3, mediaFile: "sting.mp3", durationMs: 2000 }));
      expect(video.isConnected).toBe(false);
      Object.defineProperty(video, "readyState", { value: 1 });
      video.dispatchEvent(new window.Event("loadedmetadata"));
      await Promise.resolve();
      expect(playback.filter((entry) => entry.media === video)).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("pauses a removed video again if its pending play promise resolves", async () => {
    let resolvePlay: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { resolvePlay = resolve; });
    const { document, source, playback, paused, waitFor, dom } = await mountOverlay(
      (media) => media.tagName === "VIDEO" ? pending : Promise.resolve()
    );
    try {
      source.emit("reaction", reaction({ sequence: 1, mediaFile: "clip.webm", durationMs: 2000 }));
      const video = document.querySelector("#stage video") as HTMLVideoElement;
      await waitFor(() => playback.some((entry) => entry.media === video));
      source.emit("reaction", reaction({ sequence: 2, mediaFile: "sting.mp3", durationMs: 2000 }));
      expect(video.isConnected).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pausesBeforeResolution = paused.filter((media) => media === video).length;
      resolvePlay?.();
      await waitFor(() => paused.filter((media) => media === video).length > pausesBeforeResolution);
      expect(video.getAttribute("src")).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("ignore drops while busy; replace preempts", async () => {
    const first = await mountOverlay();
    try {
      first.source.emit("reaction", reaction({ sequence: 1, durationMs: 400 }));
      await first.waitFor(
        () => first.document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "first appears"
      );
      first.source.emit(
        "reaction",
        reaction({ sequence: 2, templateId: "wow-2", queue: "ignore", durationMs: 60 })
      );
      await new Promise((r) => setTimeout(r, 120));
      expect(first.document.querySelectorAll("#stage img").length).toBe(1);
    } finally {
      first.dom.window.close();
    }

    const second = await mountOverlay();
    try {
      second.source.emit("reaction", reaction({ sequence: 1, durationMs: 2000 }));
      await second.waitFor(
        () => second.document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "first appears"
      );
      second.source.emit(
        "reaction",
        reaction({
          sequence: 2,
          templateId: "sad-1",
          moment: "sad",
          queue: "replace",
          durationMs: 60,
        })
      );
      await second.waitFor(
        () =>
          second.document.querySelector('#stage img[alt="sad reaction"]') !== null,
        5000,
        "replacement appears"
      );
    } finally {
      second.dom.window.close();
    }
  });

  it("ignores expired and duplicate triggers", async () => {
    const { document, source, waitFor, dom } = await mountOverlay();
    try {
      source.emit(
        "reaction",
        reaction({ sequence: 1, expiresAt: Date.now() - 1000, durationMs: 60 })
      );
      await new Promise((r) => setTimeout(r, 150));
      expect(document.getElementById("stage")?.childElementCount).toBe(0);

      source.emit("reaction", reaction({ sequence: 2, triggerId: "dup-1", durationMs: 60 }));
      await waitFor(
        () => document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "first delivery appears"
      );
      await waitFor(
        () => document.getElementById("stage")?.childElementCount === 0,
        5000,
        "first delivery finishes"
      );
      source.emit("reaction", reaction({ sequence: 3, triggerId: "dup-1", durationMs: 60 }));
      await new Promise((r) => setTimeout(r, 200));
      expect(document.getElementById("stage")?.childElementCount).toBe(0);
    } finally {
      dom.window.close();
    }
  });

  it("resynchronises when the relay restarts (bootId + sequence reset)", async () => {
    const { document, source, waitFor, dom } = await mountOverlay();
    try {
      source.emit("hello", { bootId: "boot-1", sequence: 0 });
      source.emit("reaction", reaction({ sequence: 1, bootId: "boot-1" }));
      await waitFor(
        () => document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "gen-1 appears"
      );
      await waitFor(
        () => document.getElementById("stage")?.childElementCount === 0,
        5000,
        "gen-1 finishes"
      );
      // Relay restart: new boot id, sequence counter back at 1.
      source.emit("hello", { bootId: "boot-2", sequence: 0 });
      source.emit("reaction", reaction({ sequence: 1, bootId: "boot-2" }));
      await waitFor(
        () => document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "post-restart event accepted despite reset sequence"
      );
    } finally {
      dom.window.close();
    }
  });

  it("survives 100 sequential coexist effects without leaking layers", async () => {
    const { document, source, waitFor, window, dom } = await mountOverlay();
    try {
      const live = () =>
        (window as unknown as { __liveEdits: { layers: () => number } })
          .__liveEdits;
      let seq = 0;
      const coexist = () =>
        reaction({
          sequence: (seq += 1),
          triggerId: `co-${seq}`,
          queue: "coexist",
          durationMs: 15,
        });
      // 10 waves of 3 concurrent layers, draining between waves.
      for (let wave = 0; wave < 10; wave += 1) {
        source.emit("reaction", coexist());
        source.emit("reaction", coexist());
        source.emit("reaction", coexist());
        await waitFor(
          () =>
            document.getElementById("stage")?.childElementCount === 0 &&
            live().layers() === 0,
          5000,
          `wave ${wave} drains`
        );
      }
      // Burst far past the layer cap: extras are refused, none leak.
      for (let i = 0; i < 70; i += 1) source.emit("reaction", coexist());
      await waitFor(
        () =>
          document.getElementById("stage")?.childElementCount === 0 &&
          live().layers() === 0,
        8000,
        "burst drains"
      );
      expect(live().layers()).toBe(0);
      // The cap is not wedged: a follow-up effect still plays.
      source.emit("reaction", reaction({ sequence: (seq += 1), durationMs: 30 }));
      await waitFor(
        () => document.querySelectorAll("#stage .effect").length === 1,
        3000,
        "follow-up plays"
      );
    } finally {
      dom.window.close();
    }
  }, 30000);
});

import { describe, it, expect } from "vitest";
import {
  effectToPlayback,
  elementForFile,
  positionClassFor,
  type PlaybackInput,
} from "../playback";
import type { AnyEffect } from "../effectSchemas";

function frameInput(): PlaybackInput {
  return {
    effect: {
      id: "effect-wow-1",
      name: "WOW",
      kind: "frame",
      templateId: "wow-1",
      moment: "wow",
      durationMs: 8000,
      delayMs: 0,
      cooldownMs: 4000,
      priority: 50,
      queue: "replace",
      enabled: true,
      zIndex: 100,
      opacity: 1,
    },
    mediaUrl: "",
    templateUrl: "/templates/wow-1.png",
  };
}

describe("playback mapping parity (M6)", () => {
  it("maps extensions to the same elements as the OBS player", () => {
    expect(elementForFile(null)).toBe("img");
    expect(elementForFile("a.png")).toBe("img");
    expect(elementForFile("a.gif")).toBe("img");
    expect(elementForFile("a.mp4")).toBe("video");
    expect(elementForFile("a.webm")).toBe("video");
    expect(elementForFile("a.mp3")).toBe("audio");
    expect(elementForFile("a.wav")).toBe("audio");
  });

  it("maps positions to the same classes as the OBS player", () => {
    expect(positionClassFor("center")).toBe("");
    expect(positionClassFor("fullscreen")).toBe("effect--fullscreen");
    expect(positionClassFor("top-left")).toBe("effect--corner effect--top-left");
    expect(positionClassFor("bottom-right")).toBe(
      "effect--corner effect--bottom-right"
    );
  });

  it("renders frame effects from the template url", () => {
    const plan = effectToPlayback(frameInput());
    expect(plan).toMatchObject({
      element: "img",
      src: "/templates/wow-1.png",
      fallbackSrc: null,
      visibleMs: 8000,
      alt: "wow reaction",
    });
  });

  it("renders video with trim, volume and fullscreen", () => {
    const effect: AnyEffect = {
      id: "v",
      name: "V",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 2700,
      delayMs: 0,
      cooldownMs: 0,
      priority: 50,
      queue: "replace",
      enabled: true,
      volume: 0.4,
      position: "fullscreen",
      entrance: "fade",
      exit: "fade",
      muted: false,
      clipStartMs: 500,
      clipEndMs: 2000,
    };
    const plan = effectToPlayback({
      effect,
      mediaUrl: "blob:clip",
      templateUrl: "/templates/wow-1.png",
    });
    expect(plan).toMatchObject({
      element: "video",
      src: "blob:clip",
      volume: 0.4,
      muted: false,
      clipStartMs: 500,
      clipEndMs: 2000,
      visibleMs: 1500,
      positionClass: "effect--fullscreen",
      entrance: "fade",
    });
  });

  it("renders audio with template fallback and relay-style src", () => {
    const effect: AnyEffect = {
      id: "a",
      name: "A",
      kind: "audio",
      mediaFile: "sting.mp3",
      moment: "sad",
      durationMs: 2700,
      delayMs: 0,
      cooldownMs: 0,
      priority: 50,
      queue: "replace",
      enabled: true,
      volume: 0.7,
      position: "center",
      entrance: "pop",
      exit: "fade",
    };
    const plan = effectToPlayback({
      effect,
      mediaUrl: "",
      templateUrl: "/templates/sad-1.png",
    });
    expect(plan).toMatchObject({
      element: "audio",
      src: "/media/sting.mp3",
      fallbackSrc: "/templates/sad-1.png",
      volume: 0.7,
    });
  });
});

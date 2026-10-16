import { describe, it, expect } from "vitest";
import {
  parseAnyEffect,
  parseEffectConfig,
  mediaKindForFile,
  templateToEffect,
} from "../effectSchemas";
import { TEMPLATES } from "../../templates/templates";

describe("media effect kinds (M3)", () => {
  it("keeps the V1 frame contract byte-for-byte compatible", () => {
    for (const t of TEMPLATES) {
      const e = templateToEffect(t);
      expect(e.kind).toBe("frame");
      expect(parseEffectConfig(e)).toEqual(e);
      expect(parseAnyEffect(e)).toEqual(e);
    }
  });

  it("parses image/video/audio/cutaway/popup effects with media defaults", () => {
    expect(
      parseAnyEffect({
        id: "img-1",
        name: "Meme",
        kind: "image",
        mediaFile: "meme.webp",
        moment: "funny",
      })
    ).toMatchObject({ kind: "image", durationMs: 2700, volume: 1, position: "center" });

    expect(
      parseAnyEffect({
        id: "vid-1",
        name: "Clip",
        kind: "video",
        mediaFile: "clip.webm",
        moment: "wow",
        clipStartMs: 500,
        clipEndMs: 2500,
        volume: 0.5,
        position: "fullscreen",
      })
    ).toMatchObject({ kind: "video", clipStartMs: 500, clipEndMs: 2500 });

    expect(
      parseAnyEffect({
        id: "aud-1",
        name: "Sting",
        kind: "audio",
        mediaFile: "sting.mp3",
        moment: "sad",
      })
    ).toMatchObject({ kind: "audio" });

    expect(
      parseAnyEffect({
        id: "cut-1",
        name: "Cutaway",
        kind: "cutaway",
        mediaFile: "scene.mp4",
        moment: "wow",
      })
    ).toMatchObject({ kind: "cutaway" });

    expect(
      parseAnyEffect({
        id: "pop-1",
        name: "Pop",
        kind: "popup",
        templateId: "wow-1",
        moment: "wow",
      })
    ).toMatchObject({ kind: "popup" });
  });

  it("rejects traversal, bad extensions, inverted clips and bad ranges", () => {
    expect(() =>
      parseAnyEffect({ id: "x", name: "x", kind: "image", mediaFile: "../evil.png", moment: "wow" })
    ).toThrow();
    expect(() =>
      parseAnyEffect({ id: "x", name: "x", kind: "video", mediaFile: "clip.avi", moment: "wow" })
    ).toThrow();
    expect(() =>
      parseAnyEffect({
        id: "x", name: "x", kind: "video", mediaFile: "c.mp4", moment: "wow",
        clipStartMs: 2000, clipEndMs: 1000,
      })
    ).toThrow();
    expect(() =>
      parseAnyEffect({ id: "x", name: "x", kind: "popup", moment: "wow" })
    ).toThrow();
    expect(() =>
      parseAnyEffect({
        id: "x", name: "x", kind: "video", mediaFile: "c.mp4", moment: "wow", volume: 2,
      })
    ).toThrow();
  });

  it("classifies filenames by playable kind", () => {
    expect(mediaKindForFile("a.png")).toBe("image");
    expect(mediaKindForFile("a.gif")).toBe("image");
    expect(mediaKindForFile("a.mp4")).toBe("video");
    expect(mediaKindForFile("a.webm")).toBe("video");
    expect(mediaKindForFile("a.mp3")).toBe("audio");
    expect(mediaKindForFile("a.wav")).toBe("audio");
    expect(mediaKindForFile("a.avi")).toBeNull();
    expect(mediaKindForFile("noext")).toBeNull();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateMediaFile,
  searchMedia,
  MediaRegistry,
  probeMediaMetadata,
  type MediaRecord,
} from "../mediaLibrary";

function record(name: string, kind: "image" | "video" | "audio" = "image"): MediaRecord {
  return {
    name,
    kind,
    bytes: 1024,
    mime: "image/png",
    url: `blob:${name}`,
    width: 100,
    height: 100,
    durationMs: null,
    available: true,
  };
}

describe("media import validation (M6)", () => {
  it("accepts relay-safe media within limits", () => {
    expect(
      validateMediaFile({ name: "clip.webm", size: 1024, type: "video/webm" })
    ).toEqual({ ok: true });
    expect(
      validateMediaFile({ name: "sting.mp3", size: 1024, type: "" })
    ).toEqual({ ok: true });
  });

  it("rejects traversal, bad types, empties and oversize files", () => {
    expect(validateMediaFile({ name: "../evil.png", size: 10, type: "" }).ok).toBe(false);
    expect(validateMediaFile({ name: "clip.avi", size: 10, type: "" }).ok).toBe(false);
    expect(validateMediaFile({ name: "a.png", size: 0, type: "" }).ok).toBe(false);
    expect(
      validateMediaFile({ name: "big.mp4", size: 51 * 1024 * 1024, type: "" })
    ).toMatchObject({ ok: false });
    expect(validateMediaFile({ name: "", size: 10, type: "" }).ok).toBe(false);
  });

  it("warns on MIME/extension disagreement instead of blocking", () => {
    expect(
      validateMediaFile({ name: "clip.webm", size: 1024, type: "video/mp4" })
    ).toEqual({ ok: true });
  });

  it("searches and filters the library", () => {
    const all = [record("laugh.webm", "video"), record("sting.wav", "audio"), record("meme.png")];
    expect(searchMedia(all, "", "all")).toHaveLength(3);
    expect(searchMedia(all, "", "video").map((r) => r.name)).toEqual(["laugh.webm"]);
    expect(searchMedia(all, "sting", "all").map((r) => r.name)).toEqual(["sting.wav"]);
    expect(searchMedia(all, "WAV", "all").map((r) => r.name)).toEqual(["sting.wav"]);
  });

  it("revokes object urls on remove and clear", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, revokeObjectURL: revoke });
    try {
      const registry = new MediaRegistry();
      registry.add(record("a.png"));
      registry.add(record("b.png"));
      expect(registry.remove("a.png")).toBe(true);
      expect(registry.remove("missing")).toBe(false);
      expect(revoke).toHaveBeenCalledWith("blob:a.png");
      registry.clear();
      expect(revoke).toHaveBeenCalledWith("blob:b.png");
      expect(registry.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("probe falls back to nulls instead of rejecting", async () => {
    const meta = await probeMediaMetadata("blob:unplayable", "video", 50);
    expect(meta).toEqual({ width: null, height: null, durationMs: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

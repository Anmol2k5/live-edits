import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateMediaFile,
  searchMedia,
  MediaRegistry,
  probeMediaMetadata,
  applyProbeResult,
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

  it("revokes the stale url when a filename is replaced", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, revokeObjectURL: revoke });
    try {
      const registry = new MediaRegistry();
      registry.add(record("a.png"));
      expect(revoke).not.toHaveBeenCalled();
      registry.add({ ...record("a.png"), url: "blob:a.png-v2", bytes: 2048 });
      expect(revoke).toHaveBeenCalledWith("blob:a.png");
      expect(registry.get("a.png")?.url).toBe("blob:a.png-v2");
      // Same url re-added (e.g. probe metadata refresh) revokes nothing.
      registry.add({ ...record("a.png"), url: "blob:a.png-v2" });
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops stale probe results after replacement or removal", () => {
    const registry = new MediaRegistry();
    registry.add(record("a.png"));
    // Replacement wins the race: the old probe must not overwrite it.
    registry.add({ ...record("a.png"), url: "blob:a.png-v2", width: 640 });
    expect(
      applyProbeResult(registry, "a.png", "blob:a.png", {
        width: 100,
        height: 100,
        durationMs: null,
      })
    ).toBe(false);
    expect(registry.get("a.png")?.width).toBe(640);
    // Matching probes still apply.
    expect(
      applyProbeResult(registry, "a.png", "blob:a.png-v2", {
        width: 320,
        height: 200,
        durationMs: null,
      })
    ).toBe(true);
    expect(registry.get("a.png")?.width).toBe(320);
    // Removal wins too.
    registry.remove("a.png");
    expect(
      applyProbeResult(registry, "a.png", "blob:a.png-v2", {
        width: 1,
        height: 1,
        durationMs: null,
      })
    ).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

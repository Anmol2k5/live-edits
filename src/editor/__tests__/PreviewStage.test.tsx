import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PreviewStage } from "../PreviewStage";
import { createEffect } from "../effectEditing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("releases the replaced video without pausing its replacement", () => {
  const paused: HTMLMediaElement[] = [];
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    paused.push(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const input = {
    effect: createEffect({ kind: "video", mediaFile: "clip.webm" }),
    mediaUrl: "blob:first",
    templateUrl: "/templates/wow-1.png",
  };
  const { container, rerender } = render(
    <PreviewStage input={input} progress={0} statusText="Playing" />
  );
  const first = container.querySelector("video");
  rerender(<PreviewStage input={{ ...input, mediaUrl: "blob:second" }} progress={0} statusText="Playing" />);
  expect(paused).toContain(first);
  expect(paused).not.toContain(container.querySelector("video"));
});

describe.each(["video", "audio"] as const)("%s preview pause", (kind) => {
  it("pauses and resumes the same media element", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const input = {
      effect: createEffect({ kind, mediaFile: kind === "video" ? "clip.webm" : "sting.wav" }),
      mediaUrl: "blob:media",
      templateUrl: "/templates/wow-1.png",
    };
    const { container, rerender } = render(<PreviewStage input={input} progress={0} statusText="Playing" />);
    const media = container.querySelector(kind);
    pause.mockClear();
    play.mockClear();
    rerender(<PreviewStage input={input} progress={0.4} statusText="Paused" paused />);
    expect(pause).toHaveBeenCalledTimes(1);
    rerender(<PreviewStage input={input} progress={0.4} statusText="Playing" />);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector(kind)).toBe(media);
  });

  it("restarts a new cue using the same source without resetting unrelated renders", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const effect = createEffect({ kind, mediaFile: kind === "video" ? "clip.webm" : "sting.wav" });
    const input = {
      effect: kind === "video" ? { ...effect, clipStartMs: 200 } : effect,
      mediaUrl: "blob:same-source",
      templateUrl: "/templates/wow-1.png",
    };
    const { container, rerender } = render(<PreviewStage input={input} progress={0} statusText="First cue" />);
    const media = container.querySelector(kind) as HTMLMediaElement;
    Object.defineProperty(media, "readyState", { value: 1 });
    fireEvent.loadedMetadata(media);
    media.currentTime = 0.9;
    rerender(<PreviewStage input={input} progress={0.9} statusText="First cue" />);
    expect(media.currentTime).toBe(0.9);
    rerender(<PreviewStage input={{ ...input }} progress={0} statusText="Second cue" />);
    expect(media.currentTime).toBe(kind === "video" ? 0.2 : 0);
  });

  it("applies a timeline seek offset after metadata loads and preserves it on resume", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const effect = createEffect({ kind, mediaFile: kind === "video" ? "clip.webm" : "sting.wav" });
    const input = {
      effect: kind === "video" ? { ...effect, clipStartMs: 200 } : effect,
      mediaUrl: "blob:seek",
      templateUrl: "/templates/wow-1.png",
    };
    const { container, rerender } = render(
      <PreviewStage input={input} progress={0.6} statusText="Seeked" paused offsetMs={600} />
    );
    const media = container.querySelector(kind) as HTMLMediaElement;
    Object.defineProperty(media, "readyState", { value: 1 });
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(kind === "video" ? 0.8 : 0.6);
    rerender(<PreviewStage input={input} progress={0.6} statusText="Resumed" offsetMs={600} />);
    expect(media.currentTime).toBe(kind === "video" ? 0.8 : 0.6);
  });
});

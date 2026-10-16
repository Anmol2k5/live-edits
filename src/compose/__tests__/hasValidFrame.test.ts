import { describe, it, expect } from "vitest";
import { hasValidFrame } from "../EditComposer";

function video(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return {
    readyState: 4,
    srcObject: {} as MediaStream,
    videoWidth: 1280,
    videoHeight: 720,
    ...overrides,
  } as HTMLVideoElement;
}

describe("hasValidFrame (M3 camera guard)", () => {
  it("accepts a live frame", () => {
    expect(hasValidFrame(video())).toBe(true);
  });

  it("rejects missing, torn-down, unready and zero-dimension video", () => {
    expect(hasValidFrame(null)).toBe(false);
    expect(hasValidFrame(undefined)).toBe(false);
    expect(hasValidFrame(video({ srcObject: null }))).toBe(false);
    expect(hasValidFrame(video({ readyState: 1 }))).toBe(false);
    expect(hasValidFrame(video({ videoWidth: 0, videoHeight: 720 }))).toBe(false);
    expect(hasValidFrame(video({ videoWidth: 640, videoHeight: 0 }))).toBe(false);
  });
});

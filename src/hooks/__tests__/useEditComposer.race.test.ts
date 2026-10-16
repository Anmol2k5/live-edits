import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEditComposer } from "../useEditComposer";

const { mockCompose, mockCaptureFrame } = vi.hoisted(() => ({
  mockCompose: vi.fn(),
  mockCaptureFrame: vi.fn(),
}));

vi.mock("../../compose/EditComposer", () => ({
  compose: (...args: unknown[]) => mockCompose(...args),
  captureFrame: (...args: unknown[]) => mockCaptureFrame(...args),
}));

vi.mock("../../templates/templates", () => ({
  getRandomTemplate: vi.fn((moment: string) => ({
    id: `${moment}-1`,
    moment,
    name: `${moment} template`,
    frameAsset: "/templates/x.png",
    photoSlot: { x: 0, y: 0, width: 10, height: 10, rotationDeg: 0 },
  })),
}));

function fakeVideo(): HTMLVideoElement {
  return {} as HTMLVideoElement;
}

describe("useEditComposer race safety (M1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureFrame.mockReturnValue({} as unknown as HTMLCanvasElement);
  });

  it("a slow stale compose never overwrites a newer edit", async () => {
    let resolveSlow!: (b: Blob) => void;
    const slow = new Promise<Blob>((res) => {
      resolveSlow = res;
    });
    const fastBlob = new Blob(["fast"], { type: "image/png" });
    const slowBlob = new Blob(["slow"], { type: "image/png" });
    mockCompose.mockReturnValueOnce(slow).mockReturnValueOnce(Promise.resolve(fastBlob));

    const { result } = renderHook(() => useEditComposer());

    act(() => {
      result.current.trigger(fakeVideo(), "wow");
    });
    act(() => {
      result.current.trigger(fakeVideo(), "sad");
    });

    // Fast (newest) finishes first.
    await waitFor(() => {
      expect(result.current.currentEdit?.blob).toBe(fastBlob);
    });

    // Stale slow finishes later — must be dropped.
    await act(async () => {
      resolveSlow(slowBlob);
      await slow;
      await Promise.resolve();
    });

    expect(result.current.currentEdit?.blob).toBe(fastBlob);
    expect(result.current.currentEdit?.moment).toBe("sad");
  });

  it("a synchronous capture failure surfaces an error instead of hanging", async () => {
    mockCaptureFrame.mockImplementationOnce(() => {
      throw new Error("Video is not ready — no frame to capture yet.");
    });
    const { result } = renderHook(() => useEditComposer());
    act(() => {
      result.current.trigger(fakeVideo(), "wow");
    });
    expect(result.current.composeError).toMatch(/not ready/i);
    expect(result.current.isComposing).toBe(false);
    expect(result.current.currentEdit).toBeNull();
  });
});

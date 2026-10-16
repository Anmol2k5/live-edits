import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMomentDetector } from "../useMomentDetector";

const { mockLoadModels, mockDetect } = vi.hoisted(() => ({
  mockLoadModels: vi.fn(),
  mockDetect: vi.fn(),
}));

vi.mock("../../detector/ExpressionModel", () => ({
  loadModels: (...args: unknown[]) => mockLoadModels(...args),
  detect: (...args: unknown[]) => mockDetect(...args),
}));

function fakeVideo(): HTMLVideoElement {
  return {
    readyState: 4,
    srcObject: {} as MediaStream,
  } as unknown as HTMLVideoElement;
}

describe("useMomentDetector guards (M1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadModels.mockResolvedValue(undefined);
    mockDetect.mockResolvedValue({
      neutral: 0,
      happy: 0,
      sad: 0,
      surprised: 0,
      angry: 0,
      disgusted: 0,
      fearful: 0,
    });
    vi.useRealTimers();
  });

  it("surfaces model load failures instead of hanging on 'Loading AI'", async () => {
    mockLoadModels.mockRejectedValueOnce(new Error("model 404"));
    const ref = { current: fakeVideo() };
    const { result } = renderHook(() => useMomentDetector(ref, true));
    await waitFor(() => {
      expect(result.current.modelsError).toMatch(/model 404/);
    });
    expect(result.current.modelsReady).toBe(false);
  });

  it("skips a tick while inference is still in flight (no overlap)", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (v: unknown) => void;
      const first = new Promise((res) => {
        resolveFirst = res;
      });
      mockDetect.mockReturnValueOnce(first);
      // Second call would resolve immediately if it were (incorrectly) started.
      mockDetect.mockResolvedValue({
        neutral: 0,
        happy: 0,
        sad: 0,
        surprised: 0,
        angry: 0,
        disgusted: 0,
        fearful: 0,
      });

      const ref = { current: fakeVideo() };
      const { result } = renderHook(() => useMomentDetector(ref, true));

      // Wait for models to be marked ready (promise microtask).
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.modelsReady).toBe(true);

      // First interval tick starts inference and leaves it pending.
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(mockDetect).toHaveBeenCalledTimes(1);

      // Second interval tick fires while the first is pending — must skip.
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(mockDetect).toHaveBeenCalledTimes(1);

      // Finishing the first inference re-arms the loop.
      await act(async () => {
        resolveFirst({
          neutral: 1,
          happy: 0,
          sad: 0,
          surprised: 0,
          angry: 0,
          disgusted: 0,
          fearful: 0,
        });
        await first;
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockDetect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

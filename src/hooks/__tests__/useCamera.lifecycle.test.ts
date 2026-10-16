import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCamera } from "../useCamera";

const { mockRequestCamera, mockStopStream } = vi.hoisted(() => ({
  mockRequestCamera: vi.fn(),
  mockStopStream: vi.fn(),
}));

vi.mock("../../camera/CameraFeed", () => ({
  requestCamera: mockRequestCamera,
  stopStream: mockStopStream,
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useCamera lifecycle (M1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stale request results never overwrite a newer restart", async () => {
    const first = deferred<{ ok: true; stream: MediaStream }>();
    const secondStream = { getTracks: () => [] } as unknown as MediaStream;
    const firstStream = { getTracks: () => [] } as unknown as MediaStream;

    mockRequestCamera
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(Promise.resolve({ ok: true as const, stream: secondStream }));

    const { result } = renderHook(() => useCamera());

    // Initial mount triggers start() -> first.promise pending.
    // Immediately restart -> second request.
    let restartPromise: Promise<void>;
    act(() => {
      restartPromise = result.current.restart();
    });

    // Resolve the stale first request AFTER the second was issued.
    await act(async () => {
      first.resolve({ ok: true, stream: firstStream });
      await first.promise.catch(() => undefined);
      await restartPromise;
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("active");
    });
    // Newest stream wins; stale stream is stopped to avoid a leak.
    if (result.current.state.status === "active") {
      expect(result.current.state.stream).toBe(secondStream);
    }
    expect(mockStopStream).toHaveBeenCalledWith(firstStream);
  });

  it("surfaces a clear error when permission is denied", async () => {
    mockRequestCamera.mockReturnValueOnce(
      Promise.resolve({ ok: false as const, error: "denied" as const, message: "Camera permission was denied." })
    );
    const { result } = renderHook(() => useCamera());
    await waitFor(() => {
      expect(result.current.state.status).toBe("error");
    });
    if (result.current.state.status === "error") {
      expect(result.current.state.error).toBe("denied");
    }
  });
});

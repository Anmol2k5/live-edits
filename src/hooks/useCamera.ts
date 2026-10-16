import { useEffect, useRef, useState, useCallback } from "react";
import { requestCamera, stopStream, type CameraErrorKind, type CameraResult } from "../camera/CameraFeed";

export type CameraState =
  | { status: "loading" }
  | { status: "active"; stream: MediaStream }
  | { status: "error"; error: CameraErrorKind; message: string };

/** Only the newest camera request may own the active stream. */
export function useCamera() {
  const [state, setState] = useState<CameraState>({ status: "loading" });
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);

  const start = useCallback(async (deviceId?: string) => {
    const generation = ++generationRef.current;
    if (!mountedRef.current) return;
    setState({ status: "loading" });

    // Stop any existing stream before acquiring a new one so restarts
    // never leak tracks.
    if (streamRef.current) {
      stopStream(streamRef.current);
      streamRef.current = null;
    }

    let result: CameraResult;
    try {
      result = await requestCamera(deviceId);
    } catch (error) {
      result = { ok: false, error: "unknown", message: String(error) };
    }

    // Stale-result rejection: a slower earlier request must never
    // overwrite a newer one. Stop a stale stream to avoid leaking it.
    if (!mountedRef.current || generation !== generationRef.current) {
      if (result.ok) stopStream(result.stream);
      return;
    }

    if (!result.ok) {
      setState({ status: "error", error: result.error, message: result.message });
      return;
    }

    const stream = result.stream;
    streamRef.current = stream;
    setState({ status: "active", stream });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void start();
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight request so it cannot commit after unmount.
      generationRef.current++;
      if (streamRef.current) {
        stopStream(streamRef.current);
        streamRef.current = null;
      }
    };
  }, [start]);

  // Surface physical disconnection: when tracks of the active stream end
  // (unplug/disable), move to a clear error state instead of a frozen preview.
  useEffect(() => {
    if (state.status !== "active") return;
    const stream = state.stream;
    const onEnded = () => {
      // Only report if this stream is still the current one.
      if (streamRef.current === stream) {
        streamRef.current = null;
        setState({
          status: "error",
          error: "not-found",
          message: "Camera was disconnected.",
        });
      }
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", onEnded);
    }
    return () => {
      for (const track of stream.getTracks()) {
        track.removeEventListener("ended", onEnded);
      }
    };
  }, [state]);

  return { state, restart: start };
}

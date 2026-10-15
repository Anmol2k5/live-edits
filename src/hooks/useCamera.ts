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
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      if (mountedRef.current && generationRef.current === generation) {
        stopStream(stream);
        streamRef.current = null;
        setState({
          status: "error",
          error: "not-found",
          message: "The selected camera was disconnected or stopped.",
        });
      }
    }, { once: true });
    setState({ status: "active", stream });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void start();
    return () => {
      mountedRef.current = false;
      generationRef.current++;
      if (streamRef.current) {
        stopStream(streamRef.current);
        streamRef.current = null;
      }
    };
  }, [start]);

  return { state, restart: start };
}

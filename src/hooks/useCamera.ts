import { useEffect, useRef, useState, useCallback } from "react";
import {
  requestCamera,
  stopStream,
  type CameraErrorKind,
  type CameraResult,
} from "../camera/CameraFeed";

export type CameraState =
  | { status: "loading" }
  | { status: "active"; stream: MediaStream }
  | { status: "error"; error: CameraErrorKind; message: string };

export function useCamera() {
  const [state, setState] = useState<CameraState>({ status: "loading" });
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async (deviceId?: string) => {
    setState({ status: "loading" });

    // Stop any existing stream
    if (streamRef.current) {
      stopStream(streamRef.current);
      streamRef.current = null;
    }

    const result: CameraResult = await requestCamera(deviceId);

    if (result.ok) {
      streamRef.current = result.stream;
      setState({ status: "active", stream: result.stream });
    } else {
      setState({ status: "error", error: result.error, message: result.message });
    }
  }, []);

  useEffect(() => {
    start();
    return () => {
      if (streamRef.current) {
        stopStream(streamRef.current);
        streamRef.current = null;
      }
    };
  }, [start]);

  return { state, restart: start };
}

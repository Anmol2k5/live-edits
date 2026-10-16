import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { CameraState } from "../hooks/useCamera";

const ERROR_MESSAGES: Record<string, { title: string; hint: string }> = {
  denied: {
    title: "Camera Access Denied",
    hint: "Please allow camera access in your browser or system settings and restart the app.",
  },
  "not-found": {
    title: "No Camera Found",
    hint: "Connect a webcam and restart the app.",
  },
  "in-use": {
    title: "Camera In Use",
    hint: "Close other apps using the camera (Zoom, OBS, etc.) and try again.",
  },
  unknown: {
    title: "Camera Error",
    hint: "An unexpected error occurred. Try restarting the app.",
  },
};

interface ViewfinderProps {
  cameraState: CameraState;
  onRetry: () => void;
}

export interface ViewfinderHandle {
  getVideo: () => HTMLVideoElement | null;
}

export const Viewfinder = forwardRef<ViewfinderHandle, ViewfinderProps>(
  function Viewfinder({ cameraState, onRetry }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    // Track which stream is currently attached so unrelated re-renders
    // (e.g. debug-bar ticks) don't reset srcObject every frame.
    const attachedStreamRef = useRef<MediaStream | null>(null);

    useImperativeHandle(ref, () => ({
      getVideo: () => videoRef.current,
    }));

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      if (cameraState.status !== "active") {
        if (video.srcObject !== null) video.srcObject = null;
        attachedStreamRef.current = null;
        return;
      }
      if (attachedStreamRef.current === cameraState.stream) return;
      attachedStreamRef.current = cameraState.stream;
      video.srcObject = cameraState.stream;
      const play = video.play();
      if (play && typeof play.catch === "function") {
        play.catch(() => {
          // Autoplay with muted+playsInline should succeed; a rejection
          // (e.g. not-yet-visible) leaves the element to start on its own.
        });
      }
      return () => {
        // Only detach if this effect attached the current stream.
        if (attachedStreamRef.current === cameraState.stream) {
          if (video.srcObject !== null) video.srcObject = null;
          attachedStreamRef.current = null;
        }
      };
      // Depend on the stream identity, not the whole cameraState object.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraState.status === "active" ? cameraState.stream : null]);

    if (cameraState.status === "loading") {
      return (
        <div className="viewfinder viewfinder--loading">
          <div className="viewfinder__spinner" />
          <p className="viewfinder__text">Starting camera…</p>
        </div>
      );
    }

    if (cameraState.status === "error") {
      const info = ERROR_MESSAGES[cameraState.error] ?? ERROR_MESSAGES.unknown;
      return (
        <div className="viewfinder viewfinder--error">
          <div className="viewfinder__error-icon">📷</div>
          <h2 className="viewfinder__error-title">{info.title}</h2>
          <p className="viewfinder__error-hint">{info.hint}</p>
          <p className="viewfinder__error-detail">{cameraState.message}</p>
          <button className="viewfinder__retry-btn" onClick={onRetry}>
            Try Again
          </button>
        </div>
      );
    }

    return (
      <div className="viewfinder viewfinder--active">
        <video
          ref={videoRef}
          className="viewfinder__video"
          autoPlay
          playsInline
          muted
        />
      </div>
    );
  }
);

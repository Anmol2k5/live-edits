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

    useImperativeHandle(ref, () => ({
      getVideo: () => videoRef.current,
    }));

    useEffect(() => {
      const video = videoRef.current;
      if (video && cameraState.status === "active") {
        video.srcObject = cameraState.stream;
      }
      return () => {
        if (video) video.srcObject = null;
      };
    }, [cameraState]);

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

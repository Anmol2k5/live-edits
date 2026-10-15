import { useRef, useEffect, useCallback, useState } from "react";
import { publishOverlayTrigger } from "./relay/overlayClient";
import { useCamera } from "./hooks/useCamera";
import { useMomentDetector } from "./hooks/useMomentDetector";
import { useEditPipeline } from "./hooks/useEditPipeline";
import { Viewfinder, type ViewfinderHandle } from "./components/Viewfinder";
import { MomentDebugBar } from "./components/MomentDebugBar";
import { EditOverlay } from "./components/EditOverlay";
import { TriggerConsole } from "./console/TriggerConsole";
import type { TriggerEvent } from "./trigger/TriggerEvent";

export default function App() {
  const { state: cameraState, restart } = useCamera();
  const viewfinderRef = useRef<ViewfinderHandle>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep videoRef synced with the viewfinder's video element
  useEffect(() => {
    const handle = viewfinderRef.current;
    if (handle) {
      videoRef.current = handle.getVideo();
    }
  });

  const isActive = cameraState.status === "active";

  const {
    scores,
    detectorState,
    lastEvent,
    modelsReady,
    modelError,
    clearLastEvent,
  } = useMomentDetector(videoRef, isActive);

  const { currentEdit, fireTrigger, dismiss, save } = useEditPipeline();
  const [relayToken, setRelayToken] = useState("");
  const [mediaFile, setMediaFile] = useState("");
  const [relayStatus, setRelayStatus] = useState("Not connected");

  const publishToOverlay = useCallback((event: TriggerEvent) => {
    if (!relayToken.trim()) return;
    void publishOverlayTrigger(event, relayToken.trim(), mediaFile)
      .then((clients) => setRelayStatus(
        clients ? "Reaction sent to " + clients + " OBS overlay(s)" : "Event accepted; no OBS overlay connected"
      ))
      .catch((error: unknown) => setRelayStatus("Relay unavailable: " + String(error)));
  }, [relayToken, mediaFile]);

  // Wire detector events to the shared pipeline
  useEffect(() => {
    if (!lastEvent) return;
    const video = videoRef.current;
    if (!video) return;

    const event: TriggerEvent = {
      source: "ai-detector",
      moment: lastEvent.moment,
      confidence: lastEvent.confidence,
      at: lastEvent.at,
    };
    fireTrigger(video, event);
    publishToOverlay(event);
    clearLastEvent();
  }, [lastEvent, fireTrigger, publishToOverlay, clearLastEvent]);

  const handleManualTrigger = useCallback(
    (event: TriggerEvent) => {
      const video = videoRef.current;
      if (video) fireTrigger(video, event);
      publishToOverlay(event);
    },
    [fireTrigger, publishToOverlay]
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          <span className="app__title-icon">🎬</span>
          Streamer Moment Overlay
        </h1>
        <div className="app__status">
          {modelError ? (
            <span className="app__status-badge app__status-badge--loading" title={modelError}>AI Error</span>
          ) : modelsReady ? (
            <span className="app__status-badge app__status-badge--ready">AI Ready</span>
          ) : (
            <span className="app__status-badge app__status-badge--loading">Loading AI…</span>
          )}
        </div>
      </header>

      <main className="app__main">
        <Viewfinder
          ref={viewfinderRef}
          cameraState={cameraState}
          onRetry={restart}
        />

        {currentEdit && (
          <EditOverlay
            edit={currentEdit}
            onDismiss={dismiss}
            onSave={save}
          />
        )}
      </main>

      <TriggerConsole onTrigger={handleManualTrigger} />
      <details className="relay-settings">
        <summary>OBS Bridge · {relayStatus}</summary>
        <div className="relay-settings__fields">
          <label>Publish token (from npm run relay)
            <input type="password" value={relayToken} onChange={(e) => setRelayToken(e.target.value)}
              placeholder="Paste local relay publish token" autoComplete="off" />
          </label>
          <label>Optional local video/audio filename (public/reactions/)
            <input value={mediaFile} onChange={(e) => setMediaFile(e.target.value)}
              placeholder="example.webm (blank uses PNG meme frame)" />
          </label>
          <small>Run npm run relay, then paste its private OBS URL into an OBS Browser Source. Webcam frames are never sent to the relay.</small>
        </div>
      </details>

      <MomentDebugBar
        scores={scores}
        detectorState={detectorState}
        modelsReady={modelsReady}
      />
    </div>
  );
}

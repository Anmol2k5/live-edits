import { useRef, useEffect, useCallback, useState } from "react";
import { publishOverlayTrigger, type PublishableTrigger } from "./relay/overlayClient";
import { useCamera } from "./hooks/useCamera";
import { useMomentDetector } from "./hooks/useMomentDetector";
import { useEditPipeline, type AnyTrigger } from "./hooks/useEditPipeline";
import { hasValidFrame } from "./compose/EditComposer";
import { Viewfinder, type ViewfinderHandle } from "./components/Viewfinder";
import { MomentDebugBar } from "./components/MomentDebugBar";
import { EditOverlay } from "./components/EditOverlay";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TriggerConsole } from "./console/TriggerConsole";
import { RelayPanel } from "./relay/RelayPanel";
import { createMomentTrigger, createTemplateTrigger } from "./trigger/triggerSchemas";

export default function App() {
  const { state: cameraState, restart } = useCamera();
  const viewfinderRef = useRef<ViewfinderHandle>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep videoRef synced with the viewfinder's video element. Runs after
  // every render on purpose: the <video> element only exists once the
  // camera is active, so we re-sync until it appears.
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
    modelsError,
    clearLastEvent,
  } = useMomentDetector(videoRef, isActive);

  const { currentEdit, composeError, fireTrigger, dismiss, save } = useEditPipeline();
  const [relayToken, setRelayToken] = useState("");
  const [mediaFile, setMediaFile] = useState("");
  const [volume, setVolume] = useState("1");
  const [durationMs, setDurationMs] = useState("");
  const [relayStatus, setRelayStatus] = useState("Not connected");

  const publishToOverlay = useCallback((event: PublishableTrigger) => {
    if (!relayToken.trim()) return;
    const parsedVolume = Number(volume);
    const parsedDuration = Number(durationMs);
    void publishOverlayTrigger(event, relayToken.trim(), {
      mediaFile,
      ...(Number.isFinite(parsedVolume) ? { volume: Math.min(1, Math.max(0, parsedVolume)) } : {}),
      ...(Number.isInteger(parsedDuration) && parsedDuration > 0 ? { durationMs: parsedDuration } : {}),
    })
      .then((clients) => setRelayStatus(
        clients ? "Reaction sent to " + clients + " OBS overlay(s)" : "Event accepted; no OBS overlay connected"
      ))
      .catch((error: unknown) => setRelayStatus("Relay unavailable: " + String(error)));
  }, [relayToken, mediaFile, volume, durationMs]);

  // Wire detector events to the shared pipeline. The event stays pending
  // until a video frame is available, so a trigger is never silently lost
  // when the preview mounts a beat later. The validated contract exercises
  // the same path the overlay relay uses.
  useEffect(() => {
    if (!lastEvent) return;
    const video = videoRef.current;
    if (!video) return;

    const event = createMomentTrigger(lastEvent.moment, {
      source: "ai-detector",
      confidence: lastEvent.confidence,
      timestamp: lastEvent.at,
    });
    fireTrigger(video, event);
    publishToOverlay(event);
    clearLastEvent();
  }, [lastEvent, fireTrigger, publishToOverlay, clearLastEvent]);

  const handleManualTrigger = useCallback(
    (event: AnyTrigger) => {
      // Camera-dependent PNG preview only when a real frame exists; the OBS
      // relay publish below works without any webcam.
      const video = videoRef.current;
      if (hasValidFrame(video)) {
        fireTrigger(video as HTMLVideoElement, event);
      }
      publishToOverlay(event);
    },
    [fireTrigger, publishToOverlay]
  );

  // One-click end-to-end check: a validated contract trigger straight to
  // the relay. Needs no camera and touches no local preview.
  const handleTestReaction = useCallback(() => {
    publishToOverlay(
      createTemplateTrigger("wow-1", { source: "manual" })
    );
  }, [publishToOverlay]);

  // Manual OBS triggers stay available without a webcam once a relay token
  // is configured; the local PNG preview still needs the camera.
  const consoleDisabled = !isActive && !relayToken.trim();

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          <span className="app__title-icon">🎬</span>
          Streamer Moment Overlay
        </h1>
        <div className="app__status">
          {modelsError ? (
            <span className="app__status-badge app__status-badge--loading" title={modelsError} role="alert">AI Error</span>
          ) : modelsReady ? (
            <span className="app__status-badge app__status-badge--ready">AI Ready</span>
          ) : (
            <span className="app__status-badge app__status-badge--loading">Loading AI…</span>
          )}
        </div>
      </header>

      {modelsError && (
        <div className="viewfinder__error-detail" role="alert">
          Model load failed: {modelsError} — check /models assets and reload.
        </div>
      )}
      {composeError && (
        <div className="viewfinder__error-detail" role="alert">
          Compose failed: {composeError}
        </div>
      )}

      <main className="app__main">
        <ErrorBoundary>
          <Viewfinder
            ref={viewfinderRef}
            cameraState={cameraState}
            onRetry={restart}
          />
        </ErrorBoundary>

        {currentEdit && (
          <ErrorBoundary>
            <EditOverlay
              edit={currentEdit}
              onDismiss={dismiss}
              onSave={save}
            />
          </ErrorBoundary>
        )}
      </main>

      <TriggerConsole
        onTrigger={handleManualTrigger}
        disabled={consoleDisabled}
      />
      <RelayPanel
        relayToken={relayToken}
        setRelayToken={setRelayToken}
        mediaFile={mediaFile}
        setMediaFile={setMediaFile}
        volume={volume}
        setVolume={setVolume}
        durationMs={durationMs}
        setDurationMs={setDurationMs}
        relayStatus={relayStatus}
        cameraActive={isActive}
        onTestReaction={handleTestReaction}
      />

      <MomentDebugBar
        scores={scores}
        detectorState={detectorState}
        modelsReady={modelsReady}
      />
    </div>
  );
}

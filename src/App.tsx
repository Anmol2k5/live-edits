import { useRef, useEffect, useCallback } from "react";
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
    clearLastEvent,
  } = useMomentDetector(videoRef, isActive);

  const { currentEdit, fireTrigger, dismiss, save } = useEditPipeline();

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
    clearLastEvent();
  }, [lastEvent, fireTrigger, clearLastEvent]);

  const handleManualTrigger = useCallback(
    (event: TriggerEvent) => {
      const video = videoRef.current;
      if (!video) return;
      fireTrigger(video, event);
    },
    [fireTrigger]
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          <span className="app__title-icon">🎬</span>
          Streamer Moment Overlay
        </h1>
        <div className="app__status">
          {modelsReady ? (
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

      <TriggerConsole
        onTrigger={handleManualTrigger}
        disabled={!isActive}
      />

      <MomentDebugBar
        scores={scores}
        detectorState={detectorState}
        modelsReady={modelsReady}
      />
    </div>
  );
}

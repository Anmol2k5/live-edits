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
import { RelayPanel, DEFAULT_RELAY_BASE } from "./relay/RelayPanel";
import { ReactionEditor } from "./editor/ReactionEditor";
import { MediaRegistry } from "./editor/mediaLibrary";
import {
  loadLibrary,
  saveLibrary,
  getActivePack,
  type PackLibrary,
} from "./packs/packStore";
import {
  findAssignment,
  resolveTemplateTrigger,
} from "./packs/resolve";
import type { AnyEffect } from "./effects/effectSchemas";
import type { ReactionPack } from "./packs/packSchemas";
import {
  createEffectTrigger,
  createMomentTrigger,
  createTemplateTrigger,
  isTriggerContractEvent,
} from "./trigger/triggerSchemas";
import type { TriggerSource } from "./trigger/triggerSchemas";

type View = "live" | "editor";

/** Template identity + source for button-style triggers (all sources). */
function templateOf(input: AnyTrigger): {
  templateId: string;
  source: TriggerSource;
} | null {
  if (isTriggerContractEvent(input)) {
    if (input.triggerType !== "template") return null;
    return { templateId: input.templateId, source: input.source };
  }
  if (input.source !== "manual") return null;
  return { templateId: input.templateId, source: "manual" };
}

export default function App() {
  const { state: cameraState, restart } = useCamera();
  const viewfinderRef = useRef<ViewfinderHandle>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [view, setView] = useState<View>("live");

  // Reaction packs (M6). Persisted as validated JSON without binaries.
  const [library, setLibrary] = useState<PackLibrary>(() => loadLibrary());
  const [, setMediaVersion] = useState(0);
  const mediaRef = useRef<MediaRegistry | null>(null);
  if (!mediaRef.current) {
    mediaRef.current = new MediaRegistry();
  }
  const media = mediaRef.current;

  const handleLibraryChange = useCallback((next: PackLibrary) => {
    saveLibrary(next);
    setLibrary(loadLibrary());
  }, []);

  const activePack = getActivePack(library);

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
  const [relayBase, setRelayBase] = useState(DEFAULT_RELAY_BASE);
  const [relayToken, setRelayToken] = useState("");
  const [mediaFile, setMediaFile] = useState("");
  // Blank means "no override": the effect's own volume/duration apply.
  // A global default here would silently replace saved effect configs.
  const [volume, setVolume] = useState("");
  const [durationMs, setDurationMs] = useState("");
  const [relayStatus, setRelayStatus] = useState("Not connected");

  const publishToOverlay = useCallback(
    (event: PublishableTrigger) => {
      if (!relayToken.trim()) return;
      // Explicit overrides only: blank Live-panel fields leave the saved
      // effect configuration untouched (no silent replacement).
      const parsedVolume = volume.trim() === "" ? NaN : Number(volume);
      const parsedDuration = durationMs.trim() === "" ? NaN : Number(durationMs);
      void publishOverlayTrigger(event, relayToken.trim(), {
        mediaFile,
        ...(Number.isFinite(parsedVolume) ? { volume: Math.min(1, Math.max(0, parsedVolume)) } : {}),
        ...(Number.isInteger(parsedDuration) && parsedDuration > 0 ? { durationMs: parsedDuration } : {}),
      }, activePack, relayBase)
        .then((clients) => setRelayStatus(
          clients ? "Reaction sent to " + clients + " OBS overlay(s)" : "Event accepted; no OBS overlay connected"
        ))
        .catch((error: unknown) => setRelayStatus("Relay unavailable: " + String(error)));
    },
    [relayToken, mediaFile, volume, durationMs, activePack, relayBase]
  );

  // Detector path: pack assignments win for the local preview; a pack media
  // effect skips PNG composition (nothing to composite) but still publishes
  // so OBS plays the configured effect. Frame assignments select the
  // assigned template — never a random built-in alternative.
  useEffect(() => {
    if (!lastEvent) return;
    const assigned = findAssignment(lastEvent.moment, "ai-detector", activePack);
    if (assigned && assigned.kind !== "frame") {
      publishToOverlay(
        createEffectTrigger(assigned.id, {
          source: "ai-detector",
          timestamp: lastEvent.at,
        })
      );
      clearLastEvent();
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    if (assigned) {
      const event = createTemplateTrigger(assigned.templateId, {
        source: "ai-detector",
        timestamp: lastEvent.at,
      });
      fireTrigger(video, event, activePack);
      publishToOverlay(event);
      clearLastEvent();
      return;
    }
    const event = createMomentTrigger(lastEvent.moment, {
      source: "ai-detector",
      confidence: lastEvent.confidence,
      timestamp: lastEvent.at,
    });
    fireTrigger(video, event, activePack);
    publishToOverlay(event);
    clearLastEvent();
  }, [lastEvent, fireTrigger, publishToOverlay, clearLastEvent, activePack]);

  const handleManualTrigger = useCallback(
    (event: AnyTrigger) => {
      // Manual buttons resolve through pack assignments with the same rule
      // as the pipeline: an assigned media effect publishes an effect
      // trigger (no local composition), an assigned frame composes exactly
      // that template, and anything else keeps V1 behavior.
      const template = templateOf(event);
      if (template) {
        const resolved = resolveTemplateTrigger(
          template.templateId,
          template.source,
          activePack
        );
        if (resolved.kind === "media") {
          publishToOverlay(
            createEffectTrigger(resolved.effect.id, { source: template.source })
          );
          return;
        }
        if (resolved.kind === "frame") {
          const assigned = createTemplateTrigger(resolved.template.id, {
            source: template.source,
          });
          const video = videoRef.current;
          if (hasValidFrame(video)) {
            fireTrigger(video as HTMLVideoElement, assigned, activePack);
          }
          publishToOverlay(assigned);
          return;
        }
      }
      // Camera-dependent PNG preview only when a real frame exists; the OBS
      // relay publish below works without any webcam.
      const video = videoRef.current;
      if (hasValidFrame(video)) {
        fireTrigger(video as HTMLVideoElement, event, activePack);
      }
      publishToOverlay(event);
    },
    [fireTrigger, publishToOverlay, activePack]
  );

  // One-click end-to-end check: a validated contract trigger straight to
  // the relay. Needs no camera and touches no local preview.
  const handleTestReaction = useCallback(() => {
    publishToOverlay(
      createTemplateTrigger("wow-1", { source: "manual" })
    );
  }, [publishToOverlay]);

  // Editor fires a pack effect straight at the relay with its full config.
  // The draft pack travels explicitly: unsaved edits still fire exactly
  // what the preview renders.
  const handleFireEffect = useCallback(
    (effect: AnyEffect, pack: ReactionPack) => {
      if (!relayToken.trim()) return;
      void publishOverlayTrigger(
        createEffectTrigger(effect.id, { source: "manual" }),
        relayToken.trim(),
        {},
        pack,
        relayBase
      )
        .then((clients) => setRelayStatus(
          clients ? "Reaction sent to " + clients + " OBS overlay(s)" : "Event accepted; no OBS overlay connected"
        ))
        .catch((error: unknown) => setRelayStatus("Relay unavailable: " + String(error)));
    },
    [relayToken, relayBase]
  );

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
        <nav className="app__nav" aria-label="Views">
          <button
            type="button"
            onClick={() => setView("live")}
            aria-pressed={view === "live"}
            className={view === "live" ? "app__nav--current" : undefined}
          >
            Live
          </button>
          <button
            type="button"
            onClick={() => setView("editor")}
            aria-pressed={view === "editor"}
            className={view === "editor" ? "app__nav--current" : undefined}
          >
            Editor
          </button>
        </nav>
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

      {view === "editor" ? (
        <main className="app__main app__main--editor">
          <ErrorBoundary>
            <ReactionEditor
              library={library}
              onLibraryChange={handleLibraryChange}
              media={media}
              onMediaChange={() => setMediaVersion((v) => v + 1)}
              relayReady={relayToken.trim().length > 0}
              relayBase={relayBase}
              publishToken={relayToken}
              onFireEffect={handleFireEffect}
            />
          </ErrorBoundary>
        </main>
      ) : (
        <>
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
            relayBase={relayBase}
            setRelayBase={setRelayBase}
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
        </>
      )}

      <MomentDebugBar
        scores={scores}
        detectorState={detectorState}
        modelsReady={modelsReady}
      />
    </div>
  );
}

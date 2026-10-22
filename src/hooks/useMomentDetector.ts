import { useEffect, useRef, useState, useCallback } from "react";
import { loadModels, detect, type ExpressionScores } from "../detector/ExpressionModel";
import { MomentDetector, type DetectorState, type MomentEvent, type DetectorConfig } from "../detector/MomentDetector";

const POLL_INTERVAL_MS = 400;

export interface MomentDetectorHookResult {
  scores: ExpressionScores | null;
  detectorState: DetectorState;
  lastEvent: MomentEvent | null;
  modelsReady: boolean;
  modelsError: string | null;
  clearLastEvent: () => void;
}

export function useMomentDetector(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  config?: Partial<DetectorConfig>
): MomentDetectorHookResult {
  const [scores, setScores] = useState<ExpressionScores | null>(null);
  const [detectorState, setDetectorState] = useState<DetectorState>({ status: "idle" });
  const [lastEvent, setLastEvent] = useState<MomentEvent | null>(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const detectorRef = useRef<MomentDetector | null>(null);
  // Stabilise config identity: an inline object literal must not recreate
  // the detector on every render.
  const configKey = JSON.stringify(config ?? null);
  const configRef = useRef<Partial<DetectorConfig> | undefined>(config);
  configRef.current = config;

  const clearLastEvent = useCallback(() => setLastEvent(null), []);

  // Load models once. Concurrent mounts share the module-level load promise
  // (see ExpressionModel); a failure is surfaced so the UI can offer a retry.
  useEffect(() => {
    let cancelled = false;
    setModelsError(null);
    void loadModels()
      .then(() => {
        if (!cancelled) {
          setModelsReady(true);
          setModelsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setModelsReady(false);
          setModelsError(
            error instanceof Error ? error.message : `Could not load face models: ${String(error)}`
          );
        }
      });
    return () => { cancelled = true; };
  }, []);

  // Create detector (recreated only when the serialised config changes).
  useEffect(() => {
    const detector = new MomentDetector(configRef.current);
    detector.setOnMoment((event) => setLastEvent(event));
    detectorRef.current = detector;
    return () => {
      detector.reset();
      if (detectorRef.current === detector) {
        detectorRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  // Self-scheduling loop: no overlapping inference, even when processing
  // takes longer than the poll interval. Stale results (unmounted, replaced
  // video element, torn-down stream) are rejected.
  useEffect(() => {
    if (!active || !modelsReady) return;
    const detector = detectorRef.current;
    if (!detector) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    detector.arm();
    setDetectorState(detector.getState());

    const run = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.srcObject !== null) {
        try {
          const result = await detect(video);
          if (!cancelled && videoRef.current === video) {
            setScores(result);
            detector.tick(result);
            setDetectorState(detector.getState());
          }
        } catch (error) {
          // detect() maps inference faults to empty scores, so this is
          // defensive only — never break the loop on one bad frame.
          if (!cancelled) {
            setModelsError(`Face inference failed: ${String(error)}`);
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => void run(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void run(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      detector.reset();
      setDetectorState({ status: "idle" });
    };
  }, [active, modelsReady, videoRef, configKey]);

  return { scores, detectorState, lastEvent, modelsReady, modelsError, clearLastEvent };
}

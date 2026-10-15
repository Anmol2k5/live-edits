import { useEffect, useRef, useState, useCallback } from "react";
import { loadModels, detect, type ExpressionScores } from "../detector/ExpressionModel";
import { MomentDetector, type DetectorState, type MomentEvent, type DetectorConfig } from "../detector/MomentDetector";

const POLL_INTERVAL_MS = 400;

export interface MomentDetectorHookResult {
  scores: ExpressionScores | null;
  detectorState: DetectorState;
  lastEvent: MomentEvent | null;
  modelsReady: boolean;
  modelError: string | null;
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
  const [modelError, setModelError] = useState<string | null>(null);
  const detectorRef = useRef<MomentDetector | null>(null);
  const clearLastEvent = useCallback(() => setLastEvent(null), []);

  useEffect(() => {
    let cancelled = false;
    void loadModels()
      .then(() => { if (!cancelled) setModelsReady(true); })
      .catch((error: unknown) => {
        if (!cancelled) setModelError(`Could not load face models: ${String(error)}`);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const detector = new MomentDetector(config);
    detector.setOnMoment(setLastEvent);
    detectorRef.current = detector;
    return () => {
      detector.reset();
      detectorRef.current = null;
    };
  }, [config]);

  // Self-scheduling loop: no overlapping inference, even when processing takes >400ms.
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
      if (video && video.readyState >= 2) {
        try {
          const result = await detect(video);
          if (!cancelled && videoRef.current === video) {
            setScores(result);
            detector.tick(result);
            setDetectorState(detector.getState());
          }
        } catch (error) {
          if (!cancelled) setModelError(`Face inference failed: ${String(error)}`);
        }
      }
      if (!cancelled) timer = setTimeout(() => void run(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void run(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      detector.reset();
    };
  }, [active, modelsReady, videoRef]);

  return { scores, detectorState, lastEvent, modelsReady, modelError, clearLastEvent };
}

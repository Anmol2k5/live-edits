import { useEffect, useRef, useState, useCallback } from "react";
import { loadModels, detect, type ExpressionScores } from "../detector/ExpressionModel";
import { MomentDetector, type DetectorState, type MomentEvent, type DetectorConfig } from "../detector/MomentDetector";

const POLL_INTERVAL_MS = 400;

export interface MomentDetectorHookResult {
  scores: ExpressionScores | null;
  detectorState: DetectorState;
  lastEvent: MomentEvent | null;
  modelsReady: boolean;
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
  const detectorRef = useRef<MomentDetector | null>(null);

  const clearLastEvent = useCallback(() => setLastEvent(null), []);

  // Load models once
  useEffect(() => {
    let cancelled = false;
    loadModels().then(() => {
      if (!cancelled) setModelsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Create detector
  useEffect(() => {
    const detector = new MomentDetector(config);
    detector.setOnMoment((event) => setLastEvent(event));
    detectorRef.current = detector;
    return () => {
      detector.reset();
      detectorRef.current = null;
    };
  }, [config]);

  // Polling loop
  useEffect(() => {
    if (!active || !modelsReady) return;

    const detector = detectorRef.current;
    if (!detector) return;

    detector.arm();
    setDetectorState(detector.getState());

    const interval = setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const result = await detect(video);
      setScores(result);
      detector.tick(result);
      setDetectorState(detector.getState());
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      detector.reset();
      setDetectorState({ status: "idle" });
    };
  }, [active, modelsReady, videoRef]);

  return { scores, detectorState, lastEvent, modelsReady, clearLastEvent };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EffectScheduler } from "../effects/scheduler";
import type { AnyEffect } from "../effects/effectSchemas";
import {
  computeTimeline,
  cueAt,
  sequenceDuration,
  type TimedCue,
} from "./sequencePlayer";
import type { SequenceStep } from "../packs/packSchemas";

export type PlaybackStatus = "idle" | "playing" | "paused";

export interface SequencePlayback {
  status: PlaybackStatus;
  elapsedMs: number;
  totalMs: number;
  cues: TimedCue[];
  current: TimedCue | null;
  skippedStepIds: string[];
  play: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  reset: () => void;
}

export interface SequencePlaybackCallbacks {
  onCueStart?: (cue: TimedCue) => void;
  onCueEnd?: (cue: TimedCue) => void;
  onFinish?: () => void;
  onSkipped?: (cue: TimedCue, reason: string) => void;
}

/**
 * Timed sequence player. The timeline (delays/durations) is pure math, but
 * every cue admission goes through the SHARED EffectScheduler core — the
 * same decisions the OBS overlay makes. A skipped cue (cooldown/duplicate)
 * is reported, never silently faked.
 */
export function useSequencePlayback(
  steps: SequenceStep[],
  effects: AnyEffect[],
  callbacks: SequencePlaybackCallbacks = {},
  tickMs = 100
): SequencePlayback {
  const effectsById = useMemo(() => new Map(effects.map((e) => [e.id, e])), [effects]);
  const cues = useMemo(
    () => computeTimeline(steps, effectsById),
    [steps, effectsById]
  );
  const totalMs = useMemo(() => sequenceDuration(cues), [cues]);

  const schedulerRef = useRef<EffectScheduler | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = new EffectScheduler({ maxQueue: 6 });
  }
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [skippedStepIds, setSkippedStepIds] = useState<string[]>([]);
  const runRef = useRef({ id: 0, startedAt: 0, base: 0, currentId: null as string | null });
  const skippedRef = useRef<Set<string>>(new Set());
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const effectsRef = useRef(effectsById);
  effectsRef.current = effectsById;

  const stopTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearTimer = useCallback(() => {
    if (stopTimer.current !== null) {
      clearInterval(stopTimer.current);
      stopTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // A new timeline invalidates the run — identified by content signature so
  // re-renders with identical steps never reset a playing sequence.
  const cueSignature = JSON.stringify(cues.map((c) => [c.stepId, c.startAtMs, c.durationMs]));
  const lastSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSignatureRef.current === cueSignature) return;
    lastSignatureRef.current = cueSignature;
    const run = runRef.current;
    run.base = 0;
    run.currentId = null;
    skippedRef.current.clear();
    setElapsedMs(0);
    setSkippedStepIds([]);
    setStatus("idle");
    clearTimer();
  }, [cueSignature, clearTimer]);

  const tick = useCallback(() => {
    const run = runRef.current;
    const elapsed = run.base + (Date.now() - run.startedAt);
    const timeline = cuesRef.current;
    if (elapsed >= sequenceDuration(timeline)) {
      const prev = timeline.find((c) => c.stepId === run.currentId);
      if (prev) callbacksRef.current.onCueEnd?.(prev);
      run.currentId = null;
      setElapsedMs(sequenceDuration(timeline));
      setStatus("idle");
      clearTimer();
      callbacksRef.current.onFinish?.();
      return;
    }
    setElapsedMs(elapsed);
    const cue = cueAt(timeline, elapsed);
    if ((cue?.stepId ?? null) === run.currentId) return;
    // A cue the scheduler refused stays refused for this run: re-admitting
    // every tick would spam duplicate/cooldown drops and onSkipped.
    if (cue && skippedRef.current.has(cue.stepId)) return;
    if (run.currentId !== null) {
      const prev = timeline.find((c) => c.stepId === run.currentId);
      if (prev) callbacksRef.current.onCueEnd?.(prev);
    }
    run.currentId = cue?.stepId ?? null;
    if (!cue) return;
    const effect = effectsRef.current.get(cue.effectId);
    if (!effect) return;
    const scheduler = schedulerRef.current as EffectScheduler;
    const result = scheduler.submit(effect, {
      id: `seq-${run.id}-${cue.stepId}`,
    });
    if (result.action === "drop") {
      skippedRef.current.add(cue.stepId);
      setSkippedStepIds((prev) => (prev.includes(cue.stepId) ? prev : [...prev, cue.stepId]));
      callbacksRef.current.onSkipped?.(cue, result.reason);
      run.currentId = null;
      return;
    }
    scheduler.finish(result.key);
    callbacksRef.current.onCueStart?.(cue);
  }, [clearTimer]);

  const play = useCallback(() => {
    const run = runRef.current;
    if (cuesRef.current.length === 0) return;
    run.id += 1;
    run.startedAt = Date.now();
    run.currentId = null;
    skippedRef.current.clear();
    setSkippedStepIds([]);
    setStatus("playing");
    clearTimer();
    stopTimer.current = setInterval(tick, tickMs);
    tick();
  }, [tick, clearTimer, tickMs]);

  const pause = useCallback(() => {
    const run = runRef.current;
    run.base += Date.now() - run.startedAt;
    setElapsedMs(run.base);
    setStatus("paused");
    clearTimer();
  }, [clearTimer]);

  const seek = useCallback(
    (ms: number) => {
      const run = runRef.current;
      const clamped = Math.max(0, Math.min(ms, sequenceDuration(cuesRef.current)));
      if (run.currentId !== null) {
        const prev = cuesRef.current.find((c) => c.stepId === run.currentId);
        if (prev) callbacksRef.current.onCueEnd?.(prev);
        run.currentId = null;
      }
      run.base = clamped;
      run.startedAt = Date.now();
      skippedRef.current.clear();
      setSkippedStepIds([]);
      setElapsedMs(clamped);
      setStatus("paused");
      clearTimer();
    },
    [clearTimer]
  );

  const reset = useCallback(() => {
    const run = runRef.current;
    if (run.currentId !== null) {
      const prev = cuesRef.current.find((c) => c.stepId === run.currentId);
      if (prev) callbacksRef.current.onCueEnd?.(prev);
      run.currentId = null;
    }
    run.base = 0;
    skippedRef.current.clear();
    setElapsedMs(0);
    setSkippedStepIds([]);
    setStatus("idle");
    clearTimer();
  }, [clearTimer]);

  const current = cueAt(cues, elapsedMs);

  return {
    status,
    elapsedMs,
    totalMs,
    cues,
    current: status === "idle" ? null : current,
    skippedStepIds,
    play,
    pause,
    seek,
    reset,
  };
}

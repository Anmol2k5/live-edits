import type { AnyEffect } from "../effects/effectSchemas";
import type { SequenceStep } from "../packs/packSchemas";

export interface TimedCue {
  stepId: string;
  effectId: string;
  /** Offset from sequence start, including the step's own delay. */
  startAtMs: number;
  durationMs: number;
}

/**
 * Pure sequence timeline: step N starts when step N-1's effect window ends,
 * plus its own delay. Duration comes from the effect config so the preview
 * and a future OBS sequence play the same windows.
 */
export function computeTimeline(
  steps: SequenceStep[],
  effects: Map<string, AnyEffect> | AnyEffect[]
): TimedCue[] {
  const byId =
    effects instanceof Map
      ? effects
      : new Map(effects.map((e) => [e.id, e]));
  const cues: TimedCue[] = [];
  let cursor = 0;
  for (const step of steps) {
    const effect = byId.get(step.effectId);
    if (!effect || !effect.enabled) continue;
    const startAtMs = cursor + step.delayMs;
    cues.push({
      stepId: step.id,
      effectId: step.effectId,
      startAtMs,
      durationMs: effect.durationMs,
    });
    cursor = startAtMs + effect.durationMs;
  }
  return cues;
}

export function sequenceDuration(cues: TimedCue[]): number {
  if (cues.length === 0) return 0;
  const last = cues[cues.length - 1] as TimedCue;
  return last.startAtMs + last.durationMs;
}

/** Cue active at an elapsed offset (null when idle/gap). */
export function cueAt(cues: TimedCue[], elapsedMs: number): TimedCue | null {
  for (const cue of cues) {
    if (elapsedMs >= cue.startAtMs && elapsedMs < cue.startAtMs + cue.durationMs) {
      return cue;
    }
  }
  return null;
}

/** Index of the first cue at or after an offset — timeline seek target. */
export function seekIndex(cues: TimedCue[], elapsedMs: number): number {
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i] as TimedCue;
    if (elapsedMs < cue.startAtMs + cue.durationMs) return i;
  }
  return cues.length;
}

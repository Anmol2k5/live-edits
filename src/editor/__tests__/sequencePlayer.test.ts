import { describe, it, expect } from "vitest";
import {
  computeTimeline,
  sequenceDuration,
  cueAt,
  seekIndex,
} from "../sequencePlayer";
import type { AnyEffect } from "../../effects/effectSchemas";
import type { SequenceStep } from "../../packs/packSchemas";

function video(id: string, durationMs: number, enabled = true): AnyEffect {
  return {
    id,
    name: id,
    kind: "video",
    mediaFile: "clip.webm",
    moment: "wow",
    durationMs,
    delayMs: 0,
    cooldownMs: 0,
    priority: 50,
    queue: "replace",
    enabled,
    volume: 1,
    position: "center",
    entrance: "pop",
    exit: "fade",
    muted: false,
  };
}

function step(id: string, effectId: string, delayMs: number): SequenceStep {
  return { id, effectId, delayMs };
}

describe("sequence timeline (M6)", () => {
  const effects = [video("a", 1000), video("b", 500), video("c", 250, false)];

  it("chains delays and durations, skipping disabled effects", () => {
    const cues = computeTimeline(
      [step("s1", "a", 100), step("s2", "b", 200), step("s3", "c", 0)],
      effects
    );
    expect(cues).toEqual([
      { stepId: "s1", effectId: "a", startAtMs: 100, durationMs: 1000 },
      { stepId: "s2", effectId: "b", startAtMs: 1300, durationMs: 500 },
    ]);
    expect(sequenceDuration(cues)).toBe(1800);
    expect(sequenceDuration([])).toBe(0);
  });

  it("drops steps pointing at missing effects", () => {
    const cues = computeTimeline([step("s1", "ghost", 0)], effects);
    expect(cues).toEqual([]);
  });

  it("locates the active cue and seek targets", () => {
    const cues = computeTimeline(
      [step("s1", "a", 100), step("s2", "b", 200)],
      effects
    );
    expect(cueAt(cues, 50)).toBeNull();
    expect(cueAt(cues, 100)?.effectId).toBe("a");
    expect(cueAt(cues, 1099)?.effectId).toBe("a");
    expect(cueAt(cues, 1100)).toBeNull();
    expect(cueAt(cues, 1300)?.effectId).toBe("b");
    expect(cueAt(cues, 9999)).toBeNull();
    expect(seekIndex(cues, 0)).toBe(0);
    expect(seekIndex(cues, 1150)).toBe(1);
    expect(seekIndex(cues, 9999)).toBe(2);
  });
});

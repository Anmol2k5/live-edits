import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSequencePlayback } from "../useSequencePlayback";
import type { AnyEffect } from "../../effects/effectSchemas";
import type { SequenceStep } from "../../packs/packSchemas";

function video(id: string, durationMs: number, extra: Partial<AnyEffect> = {}): AnyEffect {
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
    enabled: true,
    volume: 1,
    position: "center",
    entrance: "pop",
    exit: "fade",
    muted: false,
    ...extra,
  } as AnyEffect;
}

describe("useSequencePlayback (M6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays cues in order through the shared scheduler and finishes", () => {
    const effects = [video("a", 500), video("b", 500)];
    const steps: SequenceStep[] = [
      { id: "s1", effectId: "a", delayMs: 0 },
      { id: "s2", effectId: "b", delayMs: 100 },
    ];
    const started: string[] = [];
    let finished = 0;
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, {
        onCueStart: (cue) => void started.push(cue.effectId),
        onFinish: () => void (finished += 1),
      })
    );
    expect(result.current.totalMs).toBe(1100);
    act(() => {
      result.current.play();
    });
    expect(result.current.status).toBe("playing");
    expect(started).toEqual(["a"]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // t=500 sits in the 100ms gap before step 2 — cue ends, nothing starts.
    expect(started).toEqual(["a"]);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(started).toEqual(["a", "b"]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(finished).toBe(1);
    expect(result.current.status).toBe("idle");
  });

  it("pauses, seeks and resets on a shared clock", () => {
    const effects = [video("a", 1000)];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 0 }];
    const { result } = renderHook(() => useSequencePlayback(steps, effects));
    act(() => {
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.elapsedMs).toBe(400);
    act(() => {
      result.current.pause();
    });
    expect(result.current.status).toBe("paused");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.elapsedMs).toBe(400);
    act(() => {
      result.current.seek(800);
    });
    expect(result.current.elapsedMs).toBe(800);
    act(() => {
      result.current.reset();
    });
    expect(result.current.elapsedMs).toBe(0);
    expect(result.current.status).toBe("idle");
  });

  it("reports scheduler-skipped cues instead of faking them", () => {
    const effects = [video("a", 500, { cooldownMs: 10_000 })];
    const steps: SequenceStep[] = [
      { id: "s1", effectId: "a", delayMs: 0 },
      { id: "s2", effectId: "a", delayMs: 0 },
    ];
    const skipped: string[] = [];
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, {
        onSkipped: (cue) => void skipped.push(cue.stepId),
      })
    );
    act(() => {
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Second firing of the same effect hits its cooldown: skipped, and the
    // run still finishes instead of hanging on a phantom cue.
    expect(skipped).toEqual(["s2"]);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.skippedStepIds).toContain("s2");
  });

  it("resumes the admitted cue without replaying it or applying cooldown again", () => {
    const effects = [video("a", 1000, { cooldownMs: 10_000 })];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 0 }];
    const onCueStart = vi.fn();
    const onCueEnd = vi.fn();
    const onSkipped = vi.fn();
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, { onCueStart, onCueEnd, onSkipped })
    );
    act(() => result.current.play());
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.pause());
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.play());
    expect(result.current.elapsedMs).toBe(400);
    expect(onCueStart).toHaveBeenCalledTimes(1);
    expect(onSkipped).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe("idle");
    expect(onCueEnd).toHaveBeenCalledTimes(1);
  });

  it("replays a finished sequence from the beginning after a paused run", () => {
    const effects = [video("a", 1000)];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 0 }];
    const onCueStart = vi.fn();
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, { onCueStart })
    );
    act(() => result.current.play());
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.pause());
    act(() => result.current.play());
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe("idle");
    act(() => result.current.play());
    expect(result.current.elapsedMs).toBe(0);
    expect(onCueStart).toHaveBeenCalledTimes(2);
  });

  it("ends the active cue when a timeline edit cancels playback", () => {
    const effects = [video("a", 1000)];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 0 }];
    const onCueEnd = vi.fn();
    const { result, rerender } = renderHook(
      ({ timeline }) => useSequencePlayback(timeline, effects, { onCueEnd }),
      { initialProps: { timeline: steps } }
    );
    act(() => result.current.play());
    rerender({ timeline: [] });
    expect(result.current.status).toBe("idle");
    expect(onCueEnd).toHaveBeenCalledOnce();
    expect(onCueEnd.mock.calls[0]?.[0].stepId).toBe("s1");
  });

  it("can seek back to an admitted cue without treating it as a duplicate", () => {
    const effects = [video("a", 1000, { cooldownMs: 10_000 })];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 0 }];
    const onCueStart = vi.fn();
    const onSkipped = vi.fn();
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, { onCueStart, onSkipped })
    );
    act(() => result.current.play());
    act(() => result.current.seek(500));
    expect(onCueStart).toHaveBeenCalledTimes(2);
    expect(onCueStart.mock.calls[1]?.[1]).toBe(500);
    expect(result.current.status).toBe("paused");
    act(() => result.current.play());
    expect(onCueStart).toHaveBeenCalledTimes(2);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it("starts a cue at its elapsed offset when a timer reaches it late", () => {
    const effects = [video("a", 1000)];
    const steps: SequenceStep[] = [{ id: "s1", effectId: "a", delayMs: 150 }];
    const onCueStart = vi.fn();
    const { result } = renderHook(() =>
      useSequencePlayback(steps, effects, { onCueStart })
    );
    act(() => result.current.play());
    act(() => vi.advanceTimersByTime(200));
    expect(onCueStart.mock.calls[0]?.[1]).toBe(50);
  });
});

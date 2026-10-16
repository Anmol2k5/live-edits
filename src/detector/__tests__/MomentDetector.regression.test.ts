import { describe, it, expect, beforeEach } from "vitest";
import { MomentDetector } from "../MomentDetector";
import type { ExpressionScores } from "../ExpressionModel";
import type { MomentEvent } from "../MomentDetector";

function scores(overrides: Partial<ExpressionScores> = {}): ExpressionScores {
  return {
    neutral: 0,
    happy: 0,
    sad: 0,
    surprised: 0,
    angry: 0,
    disgusted: 0,
    fearful: 0,
    ...overrides,
  };
}

describe("MomentDetector regression (M1)", () => {
  let detector: MomentDetector;
  let events: MomentEvent[];

  beforeEach(() => {
    detector = new MomentDetector();
    events = [];
    detector.setOnMoment((e) => events.push(e));
  });

  it("a stale happy rise before a wow trigger cannot fire funny right after cooldown", () => {
    detector.arm();
    // Tick 1: high surprise (first wow half) with low happiness baseline.
    detector.tick(scores({ surprised: 0.9, happy: 0.3 }), 1000);
    // Tick 2: surprise again + happiness jumps. Wow wins the tie-break.
    detector.tick(scores({ surprised: 0.9, happy: 0.85 }), 1400);
    expect(events).toHaveLength(1);
    expect(events[0].moment).toBe("wow");

    // Cooldown is 4000ms. Simulate sparse ticks (e.g. hidden tab): no
    // samples during cooldown, then sustained high happiness.
    const afterCooldown = 1400 + 4000 + 100;
    detector.tick(scores({ happy: 0.86 }), afterCooldown);
    detector.tick(scores({ happy: 0.87 }), afterCooldown + 400);
    // Without the M1 baseline reset, the pre-wow rise (0.3 -> 0.85) would
    // still be in the window and fire a phantom "funny".
    expect(events).toHaveLength(1);
  });

  it("all-zero (no-face) frames act as a debounce gap", () => {
    detector.arm();
    detector.tick(scores({ surprised: 0.9 }), 1000);
    // No face detected -> all zeros.
    detector.tick(scores({}), 1400);
    detector.tick(scores({ surprised: 0.9 }), 1800);
    expect(events).toHaveLength(0);
    detector.tick(scores({ surprised: 0.9 }), 2200);
    expect(events).toHaveLength(1);
  });

  it("sustained high happiness with no fresh rise never fires funny", () => {
    detector.arm();
    // 10 ticks of steady high happiness — no delta.
    for (let i = 0; i < 10; i++) {
      detector.tick(scores({ happy: 0.86 }), 1000 + i * 400);
    }
    expect(events).toHaveLength(0);
  });

  it("cooldown still blocks an immediate second wow", () => {
    detector.arm();
    detector.tick(scores({ surprised: 0.9 }), 1000);
    detector.tick(scores({ surprised: 0.9 }), 1400);
    expect(events).toHaveLength(1);
    detector.tick(scores({ surprised: 0.9 }), 1800);
    detector.tick(scores({ surprised: 0.9 }), 2200);
    expect(events).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { MomentDetector, DEFAULT_CONFIG } from "../MomentDetector";
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

describe("MomentDetector", () => {
  let detector: MomentDetector;
  let events: MomentEvent[];

  beforeEach(() => {
    detector = new MomentDetector();
    events = [];
    detector.setOnMoment((e) => events.push(e));
  });

  describe("state transitions", () => {
    it("starts in idle state", () => {
      expect(detector.getState().status).toBe("idle");
    });

    it("transitions to armed when arm() is called", () => {
      detector.arm();
      expect(detector.getState().status).toBe("armed");
    });

    it("does not fire on a single high-score sample (debounce)", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      expect(events).toHaveLength(0);
      expect(detector.getState().status).toBe("armed");
    });

    it("fires wow on two consecutive surprised samples above threshold", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.85 }), 1400);
      expect(events).toHaveLength(1);
      expect(events[0].moment).toBe("wow");
    });

    it("enters cooldown after triggering", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.85 }), 1400);
      const state = detector.getState();
      expect(state.status).toBe("cooldown");
      if (state.status === "cooldown") {
        expect(state.until).toBe(1400 + DEFAULT_CONFIG.cooldownMs);
      }
    });

    it("blocks triggers during cooldown", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.85 }), 1400);
      // Still in cooldown
      detector.tick(scores({ surprised: 0.95 }), 2000);
      detector.tick(scores({ surprised: 0.95 }), 2400);
      expect(events).toHaveLength(1); // Only the first trigger
    });

    it("returns to armed after cooldown expires", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.85 }), 1400);
      // Wait past cooldown
      detector.tick(scores({ neutral: 0.9 }), 1400 + DEFAULT_CONFIG.cooldownMs + 100);
      expect(detector.getState().status).toBe("armed");
    });

    it("can trigger again after cooldown", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.85 }), 1400);
      // Expire cooldown
      const afterCooldown = 1400 + DEFAULT_CONFIG.cooldownMs + 100;
      detector.tick(scores({ surprised: 0.9 }), afterCooldown);
      detector.tick(scores({ surprised: 0.85 }), afterCooldown + 400);
      expect(events).toHaveLength(2);
    });
  });

  describe("sad detection", () => {
    it("fires sad on two consecutive samples above sadThreshold", () => {
      detector.arm();
      detector.tick(scores({ sad: 0.9 }), 1000);
      detector.tick(scores({ sad: 0.88 }), 1400);
      expect(events).toHaveLength(1);
      expect(events[0].moment).toBe("sad");
    });

    it("does not fire sad below threshold", () => {
      detector.arm();
      detector.tick(scores({ sad: 0.8 }), 1000);
      detector.tick(scores({ sad: 0.8 }), 1400);
      expect(events).toHaveLength(0);
    });
  });

  describe("funny detection (rate-of-change)", () => {
    it("fires funny when happy is high AND has risen fast enough", () => {
      detector.arm();
      // Build up the rate-of-change window: start low
      detector.tick(scores({ happy: 0.3 }), 1000);
      // Then jump high
      detector.tick(scores({ happy: 0.85 }), 1400);
      // Second consecutive high hit with delta present
      detector.tick(scores({ happy: 0.88 }), 1800);
      expect(events).toHaveLength(1);
      expect(events[0].moment).toBe("funny");
    });

    it("does NOT fire funny for a resting smile (high but no delta)", () => {
      detector.arm();
      // Happy stays consistently high — no rate of change
      detector.tick(scores({ happy: 0.85 }), 1000);
      detector.tick(scores({ happy: 0.86 }), 1400);
      detector.tick(scores({ happy: 0.87 }), 1800);
      detector.tick(scores({ happy: 0.88 }), 2200);
      expect(events).toHaveLength(0);
    });
  });

  describe("tie-breaking", () => {
    it("picks the higher-confidence moment when two cross threshold", () => {
      detector.arm();
      // Both surprised and sad are above threshold, surprised is higher
      detector.tick(scores({ surprised: 0.95, sad: 0.9 }), 1000);
      detector.tick(scores({ surprised: 0.93, sad: 0.88 }), 1400);
      expect(events).toHaveLength(1);
      expect(events[0].moment).toBe("wow");
    });
  });

  describe("debounce resets on gap", () => {
    it("resets consecutive count when no candidate between two hits", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      // Gap with no candidate
      detector.tick(scores({ neutral: 0.9 }), 1400);
      // New hit — should need another consecutive
      detector.tick(scores({ surprised: 0.9 }), 1800);
      expect(events).toHaveLength(0);
      // Second consecutive
      detector.tick(scores({ surprised: 0.9 }), 2200);
      expect(events).toHaveLength(1);
    });
  });

  describe("idle state ignores ticks", () => {
    it("does not trigger in idle state", () => {
      // Don't arm
      detector.tick(scores({ surprised: 0.95 }), 1000);
      detector.tick(scores({ surprised: 0.95 }), 1400);
      expect(events).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("returns to idle on reset", () => {
      detector.arm();
      detector.tick(scores({ surprised: 0.9 }), 1000);
      detector.reset();
      expect(detector.getState().status).toBe("idle");
    });
  });

  describe("neutral face produces no triggers", () => {
    it("30 seconds of neutral face = zero triggers", () => {
      detector.arm();
      // Simulate 75 ticks at 400ms = 30 seconds
      for (let i = 0; i < 75; i++) {
        detector.tick(
          scores({ neutral: 0.85, happy: 0.05, sad: 0.02, surprised: 0.01 }),
          1000 + i * 400
        );
      }
      expect(events).toHaveLength(0);
    });
  });
});

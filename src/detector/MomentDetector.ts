import type { ExpressionScores } from "./ExpressionModel";

// --- Types ---

export type MomentType = "wow" | "funny" | "sad";

export type DetectorState =
  | { status: "idle" }
  | { status: "armed" }
  | { status: "triggered"; moment: MomentType; confidence: number; at: number }
  | { status: "cooldown"; until: number };

export interface MomentEvent {
  moment: MomentType;
  confidence: number;
  at: number;
}

export interface DetectorConfig {
  /** Minimum score for surprised → wow */
  wowThreshold: number;
  /** Minimum score for happy → funny */
  funnyThreshold: number;
  /** Minimum happy delta over the rate window for funny */
  funnyDelta: number;
  /** Minimum score for sad → sad */
  sadThreshold: number;
  /** Cooldown duration in ms after a trigger */
  cooldownMs: number;
  /** Number of rate-of-change history samples for funny detection */
  rateWindowSize: number;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  wowThreshold: 0.7,
  funnyThreshold: 0.8,
  funnyDelta: 0.3,
  sadThreshold: 0.85,
  cooldownMs: 4000,
  rateWindowSize: 3, // ~3 samples at 400ms = ~1.2s window
};

// --- State machine ---

interface Candidate {
  moment: MomentType;
  confidence: number;
}

export class MomentDetector {
  private state: DetectorState = { status: "idle" };
  private config: DetectorConfig;
  private consecutiveHit: Candidate | null = null;
  private happyHistory: number[] = [];
  private onMoment: ((event: MomentEvent) => void) | null = null;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getState(): DetectorState {
    return this.state;
  }

  setOnMoment(cb: (event: MomentEvent) => void): void {
    this.onMoment = cb;
  }

  arm(): void {
    if (this.state.status === "idle") {
      this.state = { status: "armed" };
      this.consecutiveHit = null;
      this.happyHistory = [];
    }
  }

  /** Feed a new set of scores. Call this on every detection tick (~400ms). */
  tick(scores: ExpressionScores, now: number = Date.now()): void {
    // Track happy history for rate-of-change. A "no face" frame arrives as
    // all-zero scores and naturally drags the delta down, acting as a gap.
    this.happyHistory.push(scores.happy);
    if (this.happyHistory.length > this.config.rateWindowSize + 1) {
      this.happyHistory.shift();
    }

    if (this.state.status === "cooldown") {
      if (now >= this.state.until) {
        this.state = { status: "armed" };
        this.consecutiveHit = null;
        // Fall through to evaluate this tick as armed
      } else {
        return;
      }
    }

    if (this.state.status !== "armed") return;

    // Evaluate candidates
    const candidates: Candidate[] = [];

    if (scores.surprised >= this.config.wowThreshold) {
      candidates.push({ moment: "wow", confidence: scores.surprised });
    }

    if (scores.happy >= this.config.funnyThreshold && this.hasHappyDelta()) {
      candidates.push({ moment: "funny", confidence: scores.happy });
    }

    if (scores.sad >= this.config.sadThreshold) {
      candidates.push({ moment: "sad", confidence: scores.sad });
    }

    if (candidates.length === 0) {
      this.consecutiveHit = null;
      return;
    }

    // Highest confidence wins ties
    const best = candidates.reduce((a, b) =>
      b.confidence > a.confidence ? b : a
    );

    // Require two consecutive samples for the same moment type
    if (
      this.consecutiveHit &&
      this.consecutiveHit.moment === best.moment
    ) {
      // Second consecutive hit — trigger
      const event: MomentEvent = {
        moment: best.moment,
        confidence: best.confidence,
        at: now,
      };
      this.state = {
        status: "triggered",
        moment: best.moment,
        confidence: best.confidence,
        at: now,
      };
      this.onMoment?.(event);

      // Immediately transition to cooldown.
      // Reset the happy baseline so a stale pre-trigger rise cannot fire
      // "funny" immediately after cooldown without a fresh increase.
      this.state = { status: "cooldown", until: now + this.config.cooldownMs };
      this.consecutiveHit = null;
      this.happyHistory = [scores.happy];
    } else {
      // First hit — remember for next tick
      this.consecutiveHit = best;
    }
  }

  private hasHappyDelta(): boolean {
    if (this.happyHistory.length < 2) return false;
    const oldest = this.happyHistory[0];
    const newest = this.happyHistory[this.happyHistory.length - 1];
    return newest - oldest >= this.config.funnyDelta;
  }

  reset(): void {
    this.state = { status: "idle" };
    this.consecutiveHit = null;
    this.happyHistory = [];
  }
}

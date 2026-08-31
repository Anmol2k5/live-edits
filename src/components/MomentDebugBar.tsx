import type { ExpressionScores } from "../detector/ExpressionModel";
import type { DetectorState } from "../detector/MomentDetector";

interface MomentDebugBarProps {
  scores: ExpressionScores | null;
  detectorState: DetectorState;
  modelsReady: boolean;
}

const SCORE_LABELS: (keyof ExpressionScores)[] = [
  "neutral",
  "happy",
  "sad",
  "surprised",
  "angry",
  "disgusted",
  "fearful",
];

const SCORE_COLORS: Record<string, string> = {
  neutral: "#888",
  happy: "#ffd700",
  sad: "#4a90d9",
  surprised: "#ff6b35",
  angry: "#ff3333",
  disgusted: "#9b59b6",
  fearful: "#1abc9c",
};

function stateLabel(state: DetectorState): string {
  switch (state.status) {
    case "idle":
      return "⏸ Idle";
    case "armed":
      return "🔍 Armed";
    case "triggered":
      return `⚡ Triggered: ${state.moment} (${(state.confidence * 100).toFixed(0)}%)`;
    case "cooldown": {
      const remaining = Math.max(0, state.until - Date.now());
      return `⏳ Cooldown: ${(remaining / 1000).toFixed(1)}s`;
    }
  }
}

export function MomentDebugBar({ scores, detectorState, modelsReady }: MomentDebugBarProps) {
  return (
    <div className="debug-bar">
      <div className="debug-bar__status">
        <span className={`debug-bar__dot debug-bar__dot--${modelsReady ? "ready" : "loading"}`} />
        <span className="debug-bar__state">{stateLabel(detectorState)}</span>
        {!modelsReady && <span className="debug-bar__loading">Loading models…</span>}
      </div>
      <div className="debug-bar__scores">
        {SCORE_LABELS.map((label) => {
          const value = scores ? scores[label] : 0;
          return (
            <div key={label} className="debug-bar__score">
              <span className="debug-bar__score-label">{label.slice(0, 3)}</span>
              <div className="debug-bar__score-track">
                <div
                  className="debug-bar__score-fill"
                  style={{
                    width: `${value * 100}%`,
                    backgroundColor: SCORE_COLORS[label],
                  }}
                />
              </div>
              <span className="debug-bar__score-value">
                {(value * 100).toFixed(0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

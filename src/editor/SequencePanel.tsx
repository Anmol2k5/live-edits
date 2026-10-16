import type { AnyEffect } from "../effects/effectSchemas";
import type { SequenceStep } from "../packs/packSchemas";
import type { TimedCue } from "./sequencePlayer";
import type { PlaybackStatus } from "./useSequencePlayback";

interface SequencePanelProps {
  steps: SequenceStep[];
  cues: TimedCue[];
  effectsById: Map<string, AnyEffect>;
  totalMs: number;
  elapsedMs: number;
  status: PlaybackStatus;
  currentStepId: string | null;
  skippedStepIds: string[];
  onAddStep: (effectId: string) => void;
  onRemoveStep: (stepId: string) => void;
  onMoveStep: (stepId: string, direction: -1 | 1) => void;
  onPatchStep: (stepId: string, delayMs: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ms: number) => void;
  onReset: () => void;
}

export function SequencePanel(props: SequencePanelProps) {
  const {
    steps,
    cues,
    effectsById,
    totalMs,
    elapsedMs,
    status,
    currentStepId,
    skippedStepIds,
    onAddStep,
    onRemoveStep,
    onMoveStep,
    onPatchStep,
    onPlay,
    onPause,
    onSeek,
    onReset,
  } = props;

  const cueByStep = new Map(cues.map((c) => [c.stepId, c] as const));

  return (
    <section className="editor-panel editor-sequence" aria-label="Effect sequence">
      <h2>Sequence</h2>
      {steps.length === 0 ? (
        <p className="editor-empty">
          Empty sequence. Add the selected effect (or any pack effect) to
          build a timed reaction chain, then press Play to preview it through
          the shared scheduler.
        </p>
      ) : (
        <>
          <ol className="editor-track">
            {steps.map((step, index) => {
              const cue = cueByStep.get(step.id);
              const effect = effectsById.get(step.effectId);
              const left = totalMs > 0 && cue ? (cue.startAtMs / totalMs) * 100 : 0;
              const width =
                totalMs > 0 && cue ? Math.max(2, (cue.durationMs / totalMs) * 100) : 2;
              const active = currentStepId !== null && cue?.stepId === currentStepId;
              const skipped = skippedStepIds.includes(step.id);
              return (
                <li
                  key={step.id}
                  className={active ? "editor-cue editor-cue--active" : "editor-cue"}
                >
                  <div
                    className="editor-cue__bar"
                    style={{ left: `${left}%`, width: `${width}%` }}
                    aria-hidden
                  />
                  <span className="editor-cue__label">
                    {index + 1}. {effect?.name ?? step.effectId}
                    {skipped ? " (skipped)" : ""}
                    {!effect?.enabled ? " (disabled)" : ""}
                  </span>
                  <label className="editor-cue__delay">
                    delay
                    <input
                      aria-label={`Delay before step ${index + 1}`}
                      inputMode="numeric"
                      defaultValue={String(step.delayMs)}
                      key={`${step.id}-${step.delayMs}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) onPatchStep(step.id, v);
                      }}
                    />
                    ms
                  </label>
                  <span className="editor-cue__actions">
                    <button
                      type="button"
                      onClick={() => onMoveStep(step.id, -1)}
                      disabled={index === 0}
                      aria-label={`Move step ${index + 1} earlier`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveStep(step.id, 1)}
                      disabled={index === steps.length - 1}
                      aria-label={`Move step ${index + 1} later`}
                    >
                      ↓
                    </button>
                    <button type="button" onClick={() => onRemoveStep(step.id)}>
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="editor-row">
            <label className="editor-seek">
              Seek
              <input
                type="range"
                aria-label="Sequence position"
                min={0}
                max={Math.max(0, totalMs)}
                step={100}
                value={Math.min(elapsedMs, Math.max(0, totalMs))}
                onChange={(e) => onSeek(Number(e.target.value))}
              />
            </label>
            <span className="editor-status" role="status" aria-live="polite">
              {(elapsedMs / 1000).toFixed(1)}s / {(totalMs / 1000).toFixed(1)}s ·{" "}
              {status}
            </span>
          </div>
        </>
      )}
      <div className="editor-row">
        <AddStepForm effectsById={effectsById} onAdd={onAddStep} />
        {status === "playing" ? (
          <button type="button" onClick={onPause}>
            Pause
          </button>
        ) : (
          <button type="button" onClick={onPlay} disabled={steps.length === 0}>
            Play
          </button>
        )}
        <button type="button" onClick={onReset} disabled={steps.length === 0}>
          Reset
        </button>
      </div>
    </section>
  );
}

function AddStepForm({
  effectsById,
  onAdd,
}: {
  effectsById: Map<string, AnyEffect>;
  onAdd: (effectId: string) => void;
}) {
  const effects = [...effectsById.values()];
  if (effects.length === 0) return null;
  return (
    <form
      className="editor-row"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const effectId = String(data.get("effectId") ?? "");
        if (effectId) onAdd(effectId);
      }}
    >
      <select aria-label="Effect to append" name="effectId" defaultValue={effects[0]?.id ?? ""}>
        {effects.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.kind})
          </option>
        ))}
      </select>
      <button type="submit">Add step</button>
    </form>
  );
}

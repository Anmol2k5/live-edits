import type { AnyEffect, EffectPosition, Entrance, QueuePolicy } from "../effects/effectSchemas";
import type { MomentType } from "../templates/schemas";
import type { TriggerAssignment } from "../packs/packSchemas";
import type { TriggerSource } from "../trigger/triggerSchemas";
import { TEMPLATES } from "../templates/templates";

interface EffectPropertiesPanelProps {
  effect: AnyEffect | null;
  mediaNames: string[];
  errors: Record<string, string>;
  assignments: TriggerAssignment[];
  onPatch: (patch: Partial<Record<string, unknown>>) => void;
  onToggleEnabled: () => void;
  onAddAssignment: (source: TriggerSource, moment?: MomentType) => void;
  onRemoveAssignment: (id: string) => void;
  onPreview: () => void;
  onFire: () => void;
  canFire: boolean;
}

const MOMENTS: MomentType[] = ["wow", "funny", "sad"];
const SOURCES: TriggerSource[] = ["ai-detector", "manual", "timer", "hotkey"];
const POSITIONS: EffectPosition[] = [
  "center",
  "fullscreen",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const ENTRANCES: Entrance[] = ["pop", "fade", "slide-up", "none"];
const QUEUES: QueuePolicy[] = ["queue", "interrupt", "replace", "ignore", "coexist"];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className="editor-field-error" role="alert">
      {message}
    </span>
  );
}

export function EffectPropertiesPanel(props: EffectPropertiesPanelProps) {
  const {
    effect,
    mediaNames,
    errors,
    assignments,
    onPatch,
    onToggleEnabled,
    onAddAssignment,
    onRemoveAssignment,
    onPreview,
    onFire,
    canFire,
  } = props;

  if (!effect) {
    return (
      <section className="editor-panel" aria-label="Effect properties">
        <h2>Properties</h2>
        <p className="editor-empty">
          Select an effect to edit its properties — or create one from the
          media library.
        </p>
      </section>
    );
  }

  const hasMedia = effect.kind !== "frame";
  const hasTrim = effect.kind === "video" || effect.kind === "cutaway";
  const hasFallback =
    effect.kind === "audio" ||
    effect.kind === "popup" ||
    effect.kind === "frame";
  const num = (v: string): number | undefined => {
    if (v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return (
    <section className="editor-panel" aria-label="Effect properties">
      <h2>Properties</h2>
      {errors._form && (
        <p className="editor-error" role="alert">
          {errors._form}
        </p>
      )}
      <label>
        Name
        <input
          aria-label="Effect name"
          value={effect.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <FieldError message={errors.name} />
      </label>
      <div className="editor-row">
        <span className="editor-kind">Kind: {effect.kind}</span>
        <label className="editor-check">
          <input
            type="checkbox"
            checked={effect.enabled}
            onChange={onToggleEnabled}
          />
          Enabled
        </label>
      </div>
      <label>
        Moment
        <select
          aria-label="Moment"
          value={effect.moment}
          onChange={(e) => onPatch({ moment: e.target.value })}
        >
          {MOMENTS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <FieldError message={errors.moment} />
      </label>
      {hasFallback && "templateId" in effect && (
        <label>
          Template frame
          <select
            aria-label="Template frame"
            value={(effect.templateId as string | undefined) ?? ""}
            onChange={(e) =>
              onPatch({ templateId: e.target.value || undefined })
            }
          >
            <option value="">Moment default</option>
            {TEMPLATES.filter((t) => t.moment === effect.moment).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <FieldError message={errors.templateId} />
        </label>
      )}
      {hasMedia && "mediaFile" in effect && (
        <label>
          Media file
          <select
            aria-label="Media file"
            value={(effect.mediaFile as string | undefined) ?? ""}
            onChange={(e) => onPatch({ mediaFile: e.target.value })}
          >
            <option value="" disabled>
              Choose media
            </option>
            {mediaNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <FieldError message={errors.mediaFile} />
        </label>
      )}
      <label>
        Position
        <select
          aria-label="Position"
          value={"position" in effect ? String(effect.position) : "center"}
          onChange={(e) => onPatch({ position: e.target.value })}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <FieldError message={errors.position} />
      </label>
      <div className="editor-row">
        <label>
          Duration (ms)
          <input
            aria-label="Duration milliseconds"
            inputMode="numeric"
            defaultValue={String(effect.durationMs)}
            key={`dur-${effect.id}-${effect.durationMs}`}
            onBlur={(e) => {
              const v = num(e.target.value);
              if (v !== undefined) onPatch({ durationMs: Math.round(v) });
            }}
          />
          <FieldError message={errors.durationMs} />
        </label>
        <label>
          Delay (ms)
          <input
            aria-label="Delay milliseconds"
            inputMode="numeric"
            defaultValue={String(effect.delayMs)}
            key={`del-${effect.id}-${effect.delayMs}`}
            onBlur={(e) => {
              const v = num(e.target.value);
              if (v !== undefined) onPatch({ delayMs: Math.round(v) });
            }}
          />
          <FieldError message={errors.delayMs} />
        </label>
      </div>
      {hasTrim && (
        <div className="editor-row">
          <label>
            Trim start (ms)
            <input
              aria-label="Trim start milliseconds"
              inputMode="numeric"
              placeholder="0"
              defaultValue={
                "clipStartMs" in effect && effect.clipStartMs !== undefined
                  ? String(effect.clipStartMs)
                  : ""
              }
              key={`cs-${effect.id}-${"clipStartMs" in effect ? String(effect.clipStartMs ?? "") : ""}`}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                onPatch({
                  clipStartMs: raw === "" ? undefined : Math.round(num(raw) ?? NaN),
                });
              }}
            />
            <FieldError message={errors.clipStartMs} />
          </label>
          <label>
            Trim end (ms)
            <input
              aria-label="Trim end milliseconds"
              inputMode="numeric"
              placeholder="end"
              defaultValue={
                "clipEndMs" in effect && effect.clipEndMs !== undefined
                  ? String(effect.clipEndMs)
                  : ""
              }
              key={`ce-${effect.id}-${"clipEndMs" in effect ? String(effect.clipEndMs ?? "") : ""}`}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                onPatch({
                  clipEndMs: raw === "" ? undefined : Math.round(num(raw) ?? NaN),
                });
              }}
            />
            <FieldError message={errors.clipEndMs} />
          </label>
        </div>
      )}
      {"volume" in effect && (
        <label>
          Volume ({Math.round((effect.volume as number) * 100)}%)
          <input
            aria-label="Volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={effect.volume as number}
            onChange={(e) => onPatch({ volume: Number(e.target.value) })}
          />
          <FieldError message={errors.volume} />
        </label>
      )}
      <div className="editor-row">
        <label>
          Priority (0–100)
          <input
            aria-label="Priority"
            inputMode="numeric"
            defaultValue={String(effect.priority)}
            key={`pri-${effect.id}-${effect.priority}`}
            onBlur={(e) => {
              const v = num(e.target.value);
              if (v !== undefined) onPatch({ priority: Math.round(v) });
            }}
          />
          <FieldError message={errors.priority} />
        </label>
        <label>
          Cooldown (ms)
          <input
            aria-label="Cooldown milliseconds"
            inputMode="numeric"
            defaultValue={String(effect.cooldownMs)}
            key={`cd-${effect.id}-${effect.cooldownMs}`}
            onBlur={(e) => {
              const v = num(e.target.value);
              if (v !== undefined) onPatch({ cooldownMs: Math.round(v) });
            }}
          />
          <FieldError message={errors.cooldownMs} />
        </label>
      </div>
      <div className="editor-row">
        <label>
          Queue policy
          <select
            aria-label="Queue policy"
            value={effect.queue}
            onChange={(e) => onPatch({ queue: e.target.value })}
          >
            {QUEUES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
          <FieldError message={errors.queue} />
        </label>
      </div>
      {"entrance" in effect && (
        <div className="editor-row">
          <label>
            Entrance
            <select
              aria-label="Entrance animation"
              value={String(effect.entrance)}
              onChange={(e) => onPatch({ entrance: e.target.value })}
            >
              {ENTRANCES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <FieldError message={errors.entrance} />
          </label>
          <label>
            Exit
            <select
              aria-label="Exit animation"
              value={String(effect.exit)}
              onChange={(e) => onPatch({ exit: e.target.value })}
            >
              {ENTRANCES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <FieldError message={errors.exit} />
          </label>
        </div>
      )}
      {"muted" in effect && (
        <label className="editor-check">
          <input
            type="checkbox"
            checked={Boolean(effect.muted)}
            onChange={(e) => onPatch({ muted: e.target.checked })}
          />
          Muted
        </label>
      )}
      <fieldset className="editor-assign">
        <legend>Trigger assignments</legend>
        {assignments.length === 0 ? (
          <p className="editor-hint">
            No triggers yet — this effect only plays from the sequence or a
            direct fire.
          </p>
        ) : (
          <ul>
            {assignments.map((a) => (
              <li key={a.id}>
                <span>
                  {a.source}
                  {a.moment ? ` · ${a.moment}` : ""}
                </span>
                <button type="button" onClick={() => onRemoveAssignment(a.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <AssignmentAdder onAdd={onAddAssignment} moment={effect.moment} />
      </fieldset>
      <div className="editor-row">
        <button type="button" onClick={onPreview}>
          Preview
        </button>
        <button
          type="button"
          onClick={onFire}
          disabled={!canFire}
          title={canFire ? "Publish to the OBS relay" : "Paste the relay publish token first"}
        >
          Fire to OBS
        </button>
      </div>
      {!canFire && (
        <p className="editor-hint">
          Firing needs the relay publish token (OBS Bridge panel).
        </p>
      )}
    </section>
  );
}

function AssignmentAdder({
  onAdd,
  moment,
}: {
  onAdd: (source: TriggerSource, moment?: MomentType) => void;
  moment: MomentType;
}) {
  return (
    <form
      className="editor-row"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const source = String(data.get("source") ?? "manual") as TriggerSource;
        const withMoment = data.get("withMoment") === "on";
        onAdd(source, withMoment ? moment : undefined);
      }}
    >
      <select aria-label="Assignment source" name="source" defaultValue="manual">
        {SOURCES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <label className="editor-check">
        <input type="checkbox" name="withMoment" defaultChecked />
        {moment}
      </label>
      <button type="submit">Assign</button>
    </form>
  );
}

import { useState, useCallback } from "react";
import { TEMPLATES } from "../templates/templates";
import { useManualTrigger } from "./useManualTrigger";
import type { AnyTrigger } from "../hooks/useEditPipeline";
import type { MomentType } from "../trigger/TriggerEvent";

const MOMENT_ORDER = ["wow", "funny", "sad"] as const satisfies readonly MomentType[];

const MOMENT_EMOJI: Record<MomentType, string> = {
  wow: "😲",
  funny: "😂",
  sad: "😢",
};

interface TriggerConsoleProps {
  onTrigger: (event: AnyTrigger) => void;
  disabled?: boolean;
}

/**
 * Manual trigger console — 6 buttons (one per template), grouped by moment type.
 *
 * M2: emits the validated shared contract (`fireContract`) so the console →
 * pipeline path exercises the same schemas the future overlay relay and
 * backend will use. The pipeline still accepts legacy events.
 *
 * Future direction: this same interface could accept events over a WebSocket
 * from a co-host on a second device, making the console remotely operable.
 */
export function TriggerConsole({ onTrigger, disabled = false }: TriggerConsoleProps) {
  const { fireContract } = useManualTrigger();
  const [firingId, setFiringId] = useState<string | null>(null);

  const handlePress = useCallback(
    (templateId: string) => {
      if (disabled) return;
      const event = fireContract(templateId);
      if (!event) return;

      onTrigger(event);

      // Brief visual feedback
      setFiringId(templateId);
      setTimeout(() => setFiringId(null), 200);
    },
    [disabled, fireContract, onTrigger]
  );

  return (
    <div className="trigger-console">
      <div className="trigger-console__label">⚡ Manual</div>
      <div className="trigger-console__groups">
        {MOMENT_ORDER.map((moment) => {
          const templates = TEMPLATES.filter((t) => t.moment === moment);
          return (
            <div
              key={moment}
              className={`trigger-console__group trigger-console__group--${moment}`}
            >
              <span className="trigger-console__group-label">
                {MOMENT_EMOJI[moment]} {moment}
              </span>
              <div className="trigger-console__buttons">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    id={`trigger-btn-${t.id}`}
                    className={`trigger-console__btn trigger-console__btn--${t.moment}${
                      firingId === t.id ? " trigger-console__btn--firing" : ""
                    }`}
                    disabled={disabled}
                    onClick={() => handlePress(t.id)}
                    title={t.name}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

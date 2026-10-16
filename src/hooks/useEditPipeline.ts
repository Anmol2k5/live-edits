import { useCallback } from "react";
import { useEditComposer } from "./useEditComposer";
import { getTemplateById } from "../templates/templates";
import { getEffectById, getTemplateForEffect } from "../effects/registry";
import type { TriggerEvent } from "../trigger/TriggerEvent";
import { assertNever } from "../trigger/TriggerEvent";
import {
  isExpired,
  isTriggerContractEvent,
  toLegacyTrigger,
  type TriggerContractEvent,
} from "../trigger/triggerSchemas";

/**
 * Unified edit pipeline — routes a trigger from any source
 * (AI detector, manual console, timer/hotkey, future API) through the
 * shared compose path.
 *
 * M2: accepts both the legacy `TriggerEvent` and the validated
 * `TriggerContractEvent`. Contract events are normalised to the legacy
 * shape the canvas composer already understands; effect triggers are
 * resolved via the effect registry first. Expired triggers are dropped.
 */
export type AnyTrigger = TriggerEvent | TriggerContractEvent;

function normalise(input: AnyTrigger): TriggerEvent {
  if (isTriggerContractEvent(input)) {
    if (isExpired(input)) {
      throw new ExpiredTriggerError(input.id);
    }
    if (input.triggerType === "effect") {
      const effect = getEffectById(input.effectId);
      const template = getTemplateForEffect(effect);
      return { source: "manual", templateId: template.id, at: input.timestamp };
    }
    return toLegacyTrigger(input);
  }
  return input;
}

export class ExpiredTriggerError extends Error {
  constructor(public readonly triggerId: string) {
    super(`Dropped expired trigger "${triggerId}".`);
    this.name = "ExpiredTriggerError";
  }
}

export function resolveToLegacy(input: AnyTrigger): TriggerEvent {
  return normalise(input);
}

export function useEditPipeline() {
  const { currentEdit, isComposing, composeError, trigger, triggerWithTemplate, dismiss, save } =
    useEditComposer();

  const fireTrigger = useCallback(
    (video: HTMLVideoElement, input: AnyTrigger) => {
      let event: TriggerEvent;
      try {
        event = normalise(input);
      } catch (err) {
        if (err instanceof ExpiredTriggerError) return;
        throw err;
      }
      switch (event.source) {
        case "ai-detector":
          trigger(video, event.moment);
          break;
        case "manual": {
          const template = getTemplateById(event.templateId);
          triggerWithTemplate(video, template);
          break;
        }
        default:
          assertNever(event);
      }
    },
    [trigger, triggerWithTemplate]
  );

  return { currentEdit, isComposing, composeError, fireTrigger, dismiss, save };
}

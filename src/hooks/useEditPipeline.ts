import { useCallback } from "react";
import { useEditComposer } from "./useEditComposer";
import { getTemplateById } from "../templates/templates";
import { getTemplateForEffect } from "../effects/registry";
import { resolveEffectById } from "../packs/resolve";
import type { ReactionPack } from "../packs/packSchemas";
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
 * resolved via the active pack first, then the static registry.
 * Expired triggers are dropped.
 *
 * M6: only `frame` effects compose locally (they have template art).
 * Media effects resolve to their effect record so callers can publish
 * them; the canvas path stays PNG-only by design.
 */
export type AnyTrigger = TriggerEvent | TriggerContractEvent;

function normalise(input: AnyTrigger, pack?: ReactionPack | null): TriggerEvent {
  if (isTriggerContractEvent(input)) {
    if (isExpired(input)) {
      throw new ExpiredTriggerError(input.id);
    }
    if (input.triggerType === "effect") {
      const effect = resolveEffectById(input.effectId, pack);
      if (effect.kind !== "frame") {
        throw new MediaEffectError(input.effectId);
      }
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

/**
 * Effect triggers that resolve to non-frame (media) effects cannot compose
 * a PNG locally. Callers publish them to the OBS relay instead — the error
 * carries the id so the branch is explicit, never silent.
 */
export class MediaEffectError extends Error {
  constructor(public readonly effectId: string) {
    super(
      `Effect "${effectId}" is media-only and has no PNG composition path.`
    );
    this.name = "MediaEffectError";
  }
}

export function resolveToLegacy(
  input: AnyTrigger,
  pack?: ReactionPack | null
): TriggerEvent {
  return normalise(input, pack);
}

export function useEditPipeline() {
  const { currentEdit, isComposing, composeError, trigger, triggerWithTemplate, dismiss, save } =
    useEditComposer();

  const fireTrigger = useCallback(
    (video: HTMLVideoElement, input: AnyTrigger, pack?: ReactionPack | null) => {
      let event: TriggerEvent;
      try {
        event = normalise(input, pack);
      } catch (err) {
        if (err instanceof ExpiredTriggerError) return;
        if (err instanceof MediaEffectError) return;
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

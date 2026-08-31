import { useCallback } from "react";
import { useEditComposer } from "./useEditComposer";
import { getTemplateById } from "../templates/templates";
import type { TriggerEvent } from "../trigger/TriggerEvent";
import { assertNever } from "../trigger/TriggerEvent";

/**
 * Unified edit pipeline — routes a TriggerEvent from any source
 * (AI detector or manual console) through the shared compose path.
 *
 * This is the single place where "grab frame → pick template → compose → overlay"
 * lives. Neither the detector nor the console duplicates this sequence.
 */
export function useEditPipeline() {
  const { currentEdit, isComposing, trigger, triggerWithTemplate, dismiss, save } =
    useEditComposer();

  const fireTrigger = useCallback(
    (video: HTMLVideoElement, event: TriggerEvent) => {
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

  return { currentEdit, isComposing, fireTrigger, dismiss, save };
}

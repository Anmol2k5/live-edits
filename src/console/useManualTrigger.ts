import { useRef, useCallback } from "react";
import type { TriggerEvent } from "../trigger/TriggerEvent";
import {
  createTemplateTrigger,
  type TemplateTriggerEvent,
} from "../trigger/triggerSchemas";
import { getTemplateById } from "../templates/templates";

const DEBOUNCE_MS = 500;

/**
 * Manual trigger hook — converts a button press into a TriggerEvent.
 * Enforces a 500ms debounce: presses within the window return null.
 *
 * M2: `fire` keeps the legacy return for backwards compatibility;
 * `fireContract` emits the validated shared contract (same debounce).
 */
export function useManualTrigger() {
  const lastFiredAtRef = useRef<number>(0);

  const fire = useCallback((templateId: string): TriggerEvent | null => {
    // Validate the template ID (throws ZodError on unknown)
    getTemplateById(templateId);

    const now = Date.now();
    if (now - lastFiredAtRef.current < DEBOUNCE_MS) {
      return null;
    }
    lastFiredAtRef.current = now;

    return {
      source: "manual",
      templateId,
      at: now,
    };
  }, []);

  const fireContract = useCallback(
    (templateId: string): TemplateTriggerEvent | null => {
      getTemplateById(templateId);
      const now = Date.now();
      if (now - lastFiredAtRef.current < DEBOUNCE_MS) {
        return null;
      }
      lastFiredAtRef.current = now;
      return createTemplateTrigger(templateId, {
        source: "manual",
        timestamp: now,
      });
    },
    []
  );

  return { fire, fireContract };
}

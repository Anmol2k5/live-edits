import { getTemplateById } from "../templates/templates";
import { getEffectById, getTemplateForEffect } from "../effects/registry";
import type { TriggerEvent } from "../trigger/TriggerEvent";
import {
  isTriggerContractEvent,
  type TriggerContractEvent,
} from "../trigger/triggerSchemas";

const RELAY = "http://127.0.0.1:4190";

export type PublishableTrigger = TriggerEvent | TriggerContractEvent;

export interface PublishMediaOptions {
  mediaFile?: string;
  durationMs?: number;
  volume?: number;
  clipStartMs?: number;
  clipEndMs?: number;
  position?: string;
}

/**
 * Explicit opt-in: only reaction metadata, never webcam frames, leaves the
 * desktop UI. M2 contract fields (trigger id, dedup key, expiry, effect
 * reference) travel with the payload so the relay can validate, expire and
 * deduplicate at its receiving boundary.
 */
export async function publishOverlayTrigger(
  input: PublishableTrigger,
  publishToken: string,
  media: string | PublishMediaOptions = ""
): Promise<number> {
  if (!publishToken) throw new Error("Enter the relay publish token.");
  const opts: PublishMediaOptions =
    typeof media === "string" ? { mediaFile: media } : media;
  const body = buildPayload(input, opts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(RELAY + "/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + publishToken },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("OBS relay returned HTTP " + response.status);
    const result: { connectedOverlays?: number } = await response.json();
    return result.connectedOverlays ?? 0;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPayload(
  input: PublishableTrigger,
  opts: PublishMediaOptions
): Record<string, unknown> {
  const mediaFile = (opts.mediaFile ?? "").trim();
  const payload: Record<string, unknown> = {};
  if (isTriggerContractEvent(input)) {
    payload.triggerId = input.id;
    if (input.dedupKey !== undefined) payload.dedupKey = input.dedupKey;
    if (input.expiresAt !== undefined) payload.expiresAt = input.expiresAt;
    if (input.sequenceNumber !== undefined) payload.sequenceNumber = input.sequenceNumber;
    switch (input.triggerType) {
      case "moment": {
        payload.moment = input.moment;
        payload.templateId = `${input.moment}-1`;
        attachPolicy(payload, `effect-${input.moment}-1`);
        break;
      }
      case "template": {
        payload.templateId = input.templateId;
        payload.moment = getTemplateById(input.templateId).moment;
        attachPolicy(payload, `effect-${input.templateId}`);
        break;
      }
      case "effect": {
        const effect = getEffectById(input.effectId);
        const template = getTemplateForEffect(effect);
        payload.effectId = input.effectId;
        payload.templateId = template.id;
        payload.moment = template.moment;
        payload.queue = effect.queue;
        payload.priority = effect.priority;
        break;
      }
    }
  } else if (input.source === "manual") {
    payload.moment = getTemplateById(input.templateId).moment;
    payload.templateId = input.templateId;
    attachPolicy(payload, `effect-${input.templateId}`);
  } else {
    payload.moment = input.moment;
    payload.templateId = `${input.moment}-1`;
    attachPolicy(payload, `effect-${input.moment}-1`);
  }
  if (mediaFile) payload.mediaFile = mediaFile;
  if (opts.durationMs !== undefined) payload.durationMs = opts.durationMs;
  if (opts.volume !== undefined) payload.volume = opts.volume;
  if (opts.clipStartMs !== undefined) payload.clipStartMs = opts.clipStartMs;
  if (opts.clipEndMs !== undefined) payload.clipEndMs = opts.clipEndMs;
  if (opts.position !== undefined) payload.position = opts.position;
  return payload;
}

function attachPolicy(payload: Record<string, unknown>, effectId: string): void {
  try {
    const effect = getEffectById(effectId);
    payload.queue = effect.queue;
    payload.priority = effect.priority;
  } catch {
    payload.queue = "replace";
    payload.priority = 50;
  }
}

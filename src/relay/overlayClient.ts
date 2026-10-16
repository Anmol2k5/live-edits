import { getTemplateById } from "../templates/templates";
import { findAssignment, resolveEffectById, resolveTemplateForEffect } from "../packs/resolve";
import type { ReactionPack } from "../packs/packSchemas";
import type { MomentType } from "../detector/MomentDetector";
import type { TriggerEvent } from "../trigger/TriggerEvent";
import {
  isTriggerContractEvent,
  type TriggerContractEvent,
  type TriggerSource,
} from "../trigger/triggerSchemas";

const DEFAULT_RELAY = "http://127.0.0.1:4190";

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
 *
 * M6: with a pack, effect triggers resolve pack-first and media effects
 * publish their full playback config (media file, duration, volume, trim,
 * position, queue, priority, cooldown) — the same fields the editor
 * preview renders. Caller `media` options override the effect defaults.
 */
export async function publishOverlayTrigger(
  input: PublishableTrigger,
  publishToken: string,
  media: string | PublishMediaOptions = "",
  pack?: ReactionPack | null,
  relayBase: string = DEFAULT_RELAY
): Promise<number> {
  if (!publishToken) throw new Error("Enter the relay publish token.");
  const opts: PublishMediaOptions =
    typeof media === "string" ? { mediaFile: media } : media;
  const body = buildPayload(input, opts, pack);
  const base = relayBase.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(base + "/api/trigger", {
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
  opts: PublishMediaOptions,
  pack?: ReactionPack | null
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
        attachPolicy(payload, `effect-${input.moment}-1`, pack, input.moment, input.source);
        break;
      }
      case "template": {
        payload.templateId = input.templateId;
        payload.moment = getTemplateById(input.templateId).moment;
        attachPolicy(
          payload,
          `effect-${input.templateId}`,
          pack,
          payload.moment as MomentType,
          input.source
        );
        break;
      }
      case "effect": {
        applyPackEffect(payload, input.effectId, pack);
        break;
      }
    }
  } else if (input.source === "manual") {
    payload.moment = getTemplateById(input.templateId).moment;
    payload.templateId = input.templateId;
    attachPolicy(
      payload,
      `effect-${input.templateId}`,
      pack,
      payload.moment as MomentType,
      "manual"
    );
  } else {
    payload.moment = input.moment;
    payload.templateId = `${input.moment}-1`;
    attachPolicy(payload, `effect-${input.moment}-1`, pack, input.moment, input.source);
  }
  if (mediaFile) payload.mediaFile = mediaFile;
  if (opts.durationMs !== undefined) payload.durationMs = opts.durationMs;
  if (opts.volume !== undefined) payload.volume = opts.volume;
  if (opts.clipStartMs !== undefined) payload.clipStartMs = opts.clipStartMs;
  if (opts.clipEndMs !== undefined) payload.clipEndMs = opts.clipEndMs;
  if (opts.position !== undefined) payload.position = opts.position;
  return payload;
}

function attachPolicy(
  payload: Record<string, unknown>,
  effectId: string,
  pack?: ReactionPack | null,
  moment?: MomentType,
  source?: TriggerSource
): void {
  // Pack assignments share the pipeline's matching rule: an assigned
  // effect's policy wins over the static template default.
  if (moment !== undefined && source !== undefined) {
    const assigned = findAssignment(moment, source, pack);
    if (assigned) {
      payload.queue = assigned.queue;
      payload.priority = assigned.priority;
      payload.cooldownMs = assigned.cooldownMs;
      return;
    }
  }
  try {
    const effect = resolveEffectById(effectId, pack);
    payload.queue = effect.queue;
    payload.priority = effect.priority;
    payload.cooldownMs = effect.cooldownMs;
  } catch {
    payload.queue = "replace";
    payload.priority = 50;
    payload.cooldownMs = 0;
  }
}

/**
 * Pack-first effect payload. Frame effects keep the legacy template path;
 * media effects carry their full playback config so the OBS overlay plays
 * exactly what the editor preview renders. Caller media options (applied
 * afterwards in buildPayload) override effect defaults.
 */
function applyPackEffect(
  payload: Record<string, unknown>,
  effectId: string,
  pack?: ReactionPack | null
): void {
  const effect = resolveEffectById(effectId, pack);
  payload.effectId = effectId;
  payload.moment = effect.moment;
  payload.queue = effect.queue;
  payload.priority = effect.priority;
  payload.cooldownMs = effect.cooldownMs;
  if (effect.kind === "frame") {
    // V1 path: no duration override — the relay default (2700ms) applies,
    // exactly as before packs existed. Caller opts can still override.
    const template = resolveTemplateForEffect(effect);
    payload.templateId = template?.id ?? `${effect.moment}-1`;
    return;
  }
  payload.durationMs = effect.durationMs;
  const mediaFile = (effect as { mediaFile?: string }).mediaFile;
  const template = resolveTemplateForEffect(effect);
  payload.templateId = template?.id ?? `${effect.moment}-1`;
  if (mediaFile) payload.mediaFile = mediaFile;
  if ("volume" in effect) payload.volume = effect.volume;
  if ("position" in effect) payload.position = effect.position;
  if ("clipStartMs" in effect && effect.clipStartMs !== undefined) {
    payload.clipStartMs = effect.clipStartMs;
  }
  if ("clipEndMs" in effect && effect.clipEndMs !== undefined) {
    payload.clipEndMs = effect.clipEndMs;
  }
}

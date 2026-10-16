import { z } from "zod/v4";
import { MomentTypeSchema, type MomentType } from "../templates/schemas";
import type { TriggerEvent as LegacyTriggerEvent } from "./TriggerEvent";

/**
 * M2 shared trigger contracts.
 *
 * Goals:
 * - One validated shape every producer (detector, manual console, timer,
 *   hotkey, future API/Twitch) emits and every consumer (pipeline, future
 *   overlay relay / backend) accepts.
 * - Local-first: `workspaceId` is optional and reserved for M7 multi-tenant
 *   persistence. The desktop companion works without it.
 * - Backwards compatible: legacy `{source,moment|templateId,at}` events keep
 *   working via `toLegacyTrigger` / `fromLegacyTrigger`.
 */

export const TriggerSourceSchema = z.enum([
  "ai-detector",
  "manual",
  "timer",
  "hotkey",
  "api",
]);
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

const TriggerBaseSchema = z.object({
  /** Unique per trigger; used for deduplication across relays. */
  id: z.string().min(1),
  source: TriggerSourceSchema,
  /** Epoch ms when the trigger was created. */
  timestamp: z.number().int().positive(),
  /** Monotonic per-producer sequence; gaps/duplicates signal replay. */
  sequenceNumber: z.number().int().nonnegative().optional(),
  /** Reserved for M7 SaaS tenancy. Absent = local desktop session. */
  workspaceId: z.string().min(1).optional(),
  /** Triggers past this epoch ms must be dropped, not queued. */
  expiresAt: z.number().int().positive().optional(),
  /** Stable key for idempotent processing (e.g. Twitch event id). */
  dedupKey: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MomentTriggerSchema = TriggerBaseSchema.extend({
  triggerType: z.literal("moment"),
  moment: MomentTypeSchema,
  /** Detector confidence 0..1. Present for ai-detector; absent otherwise. */
  confidence: z.number().min(0).max(1).optional(),
});

export const TemplateTriggerSchema = TriggerBaseSchema.extend({
  triggerType: z.literal("template"),
  templateId: z.string().min(1),
});

export const EffectTriggerSchema = TriggerBaseSchema.extend({
  triggerType: z.literal("effect"),
  effectId: z.string().min(1),
});

export const TriggerContractSchema = z
  .discriminatedUnion("triggerType", [
    MomentTriggerSchema,
    TemplateTriggerSchema,
    EffectTriggerSchema,
  ])
  .refine((t) => t.expiresAt === undefined || t.expiresAt > t.timestamp, {
    message: "expiresAt must be after timestamp",
  });

export type MomentTriggerEvent = z.infer<typeof MomentTriggerSchema>;
export type TemplateTriggerEvent = z.infer<typeof TemplateTriggerSchema>;
export type EffectTriggerEvent = z.infer<typeof EffectTriggerSchema>;
export type TriggerContractEvent = z.infer<typeof TriggerContractSchema>;

/** Parse + validate any unknown payload at a producer/consumer boundary. */
export function parseTriggerEvent(data: unknown): TriggerContractEvent {
  return TriggerContractSchema.parse(data);
}

/** Non-throwing boundary check. */
export function isTriggerContractEvent(data: unknown): data is TriggerContractEvent {
  return TriggerContractSchema.safeParse(data).success;
}

let fallbackCounter = 0;

/** UUID without depending on a bundler polyfill. */
export function generateTriggerId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  fallbackCounter += 1;
  return `trigger-${Date.now()}-${fallbackCounter}`;
}

export interface CreateTriggerInput {
  source: TriggerSource;
  sequenceNumber?: number;
  workspaceId?: string;
  expiresAt?: number;
  dedupKey?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  timestamp?: number;
}

export function createMomentTrigger(
  moment: MomentType,
  input: CreateTriggerInput & { confidence?: number }
): MomentTriggerEvent {
  return {
    id: input.id ?? generateTriggerId(),
    source: input.source,
    triggerType: "moment",
    moment,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    timestamp: input.timestamp ?? Date.now(),
    ...(input.sequenceNumber !== undefined ? { sequenceNumber: input.sequenceNumber } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.dedupKey !== undefined ? { dedupKey: input.dedupKey } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

export function createTemplateTrigger(
  templateId: string,
  input: CreateTriggerInput
): TemplateTriggerEvent {
  return {
    id: input.id ?? generateTriggerId(),
    source: input.source,
    triggerType: "template",
    templateId,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.sequenceNumber !== undefined ? { sequenceNumber: input.sequenceNumber } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.dedupKey !== undefined ? { dedupKey: input.dedupKey } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

export function createEffectTrigger(
  effectId: string,
  input: CreateTriggerInput
): EffectTriggerEvent {
  return {
    id: input.id ?? generateTriggerId(),
    source: input.source,
    triggerType: "effect",
    effectId,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.sequenceNumber !== undefined ? { sequenceNumber: input.sequenceNumber } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.dedupKey !== undefined ? { dedupKey: input.dedupKey } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

/** True when the trigger must be dropped rather than queued/played. */
export function isExpired(
  event: Pick<TriggerContractEvent, "expiresAt">,
  now: number = Date.now()
): boolean {
  return event.expiresAt !== undefined && now > event.expiresAt;
}

/**
 * Bounded dedup cache so reconnects/replays cannot grow memory without
 * limit (§18). Evicts the oldest entry once `maxSize` is exceeded.
 */
export class TriggerDeduper {
  private seen = new Map<string, number>();
  constructor(private readonly maxSize: number = 500) {}

  /** Returns true the first time an id/key is seen, false on repeats. */
  checkAndAdd(event: Pick<TriggerContractEvent, "id" | "dedupKey">): boolean {
    const key = event.dedupKey ?? event.id;
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Convert a contract event to the legacy pipeline shape.
 * Effect triggers need registry resolution first — use
 * `resolveEffectTrigger` in the pipeline instead.
 */
export function toLegacyTrigger(event: TriggerContractEvent): LegacyTriggerEvent {
  switch (event.triggerType) {
    case "moment":
      if (event.source === "manual") {
        throw new Error("Manual moment triggers are not legacy-compatible; use a template trigger.");
      }
      return {
        source: "ai-detector",
        moment: event.moment,
        confidence: event.confidence ?? 0,
        at: event.timestamp,
      };
    case "template":
      return {
        source: "manual",
        templateId: event.templateId,
        at: event.timestamp,
      };
    case "effect":
      throw new Error(
        `Effect trigger "${event.effectId}" must be resolved via the effect registry before legacy conversion.`
      );
  }
}

/** Wrap a legacy event in the validated contract (migration adapter). */
export function fromLegacyTrigger(
  event: LegacyTriggerEvent,
  extra: { id?: string; sequenceNumber?: number } = {}
): TriggerContractEvent {
  if (event.source === "ai-detector") {
    return createMomentTrigger(event.moment, {
      source: "ai-detector",
      confidence: event.confidence,
      timestamp: event.at,
      ...(extra.id !== undefined ? { id: extra.id } : {}),
      ...(extra.sequenceNumber !== undefined ? { sequenceNumber: extra.sequenceNumber } : {}),
    });
  }
  return createTemplateTrigger(event.templateId, {
    source: "manual",
    timestamp: event.at,
    ...(extra.id !== undefined ? { id: extra.id } : {}),
    ...(extra.sequenceNumber !== undefined ? { sequenceNumber: extra.sequenceNumber } : {}),
  });
}

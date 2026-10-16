import { z } from "zod/v4";
import { MomentTypeSchema } from "../templates/schemas";
import type { Template } from "../templates/schemas";
import { TriggerSourceSchema } from "../trigger/triggerSchemas";

/**
 * M2 shared effect contracts.
 *
 * V1 scope: static PNG frame effects backed by the existing template
 * registry. Video/audio/animation kinds (§6) are intentionally NOT claimed
 * here — the schema reserves the field so M3 can extend it without a break.
 */

export const EffectKindSchema = z.enum(["frame"]);
export type EffectKind = z.infer<typeof EffectKindSchema>;

export const QueuePolicySchema = z.enum([
  "queue",
  "interrupt",
  "replace",
  "ignore",
  "coexist",
]);
export type QueuePolicy = z.infer<typeof QueuePolicySchema>;

export const EffectConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: EffectKindSchema,
  /** V1 binding to a PNG frame template in public/templates/. */
  templateId: z.string().min(1),
  moment: MomentTypeSchema,
  /** Playback window; matches the overlay autodismiss default. */
  durationMs: z.number().int().min(1).max(60000).default(8000),
  delayMs: z.number().int().min(0).max(10000).default(0),
  cooldownMs: z.number().int().min(0).max(60000).default(4000),
  priority: z.number().int().min(0).max(100).default(50),
  queue: QueuePolicySchema.default("replace"),
  enabled: z.boolean().default(true),
  /** Reserved for M3 overlay layering; validated but unused by V1 PNG path. */
  zIndex: z.number().int().min(0).max(9999).default(100),
  opacity: z.number().min(0).max(1).default(1),
});

export type EffectConfig = z.infer<typeof EffectConfigSchema>;

export const TriggerRuleSchema = z.object({
  effectId: z.string().min(1),
  enabled: z.boolean().default(true),
  allowedSources: z.array(TriggerSourceSchema).min(1).default([
    "ai-detector",
    "manual",
    "timer",
    "hotkey",
  ]),
  /** Per-rule overrides; fall back to the effect's own values. */
  cooldownMs: z.number().int().min(0).max(60000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  queue: QueuePolicySchema.optional(),
});

export type TriggerRule = z.infer<typeof TriggerRuleSchema>;

export function parseEffectConfig(data: unknown): EffectConfig {
  return EffectConfigSchema.parse(data);
}

export function parseTriggerRule(data: unknown): TriggerRule {
  return TriggerRuleSchema.parse(data);
}

/**
 * Deterministic template → effect mapping. Priority is uniform (50) so V1
 * keeps its current behaviour (random pick per moment, newest-wins compose);
 * per-moment priority tuning belongs to M6's editor, not to this adapter.
 */
export function templateToEffect(template: Template): EffectConfig {
  return EffectConfigSchema.parse({
    id: `effect-${template.id}`,
    name: template.name,
    kind: "frame",
    templateId: template.id,
    moment: template.moment,
    durationMs: 8000,
    delayMs: 0,
    cooldownMs: 4000,
    priority: 50,
    queue: "replace",
    enabled: true,
    zIndex: 100,
    opacity: 1,
  });
}

export function isEffectInCooldown(
  effect: Pick<EffectConfig, "cooldownMs">,
  lastFiredAt: number | null,
  now: number = Date.now()
): boolean {
  if (lastFiredAt === null) return false;
  return now - lastFiredAt < effect.cooldownMs;
}

export type QueueDecision = "start" | "enqueue" | "replace" | "drop";

/**
 * Pure queue-policy decision (§6). `isBusy` = an effect is currently
 * displayed/composing.
 */
export function decideQueueAction(
  policy: QueuePolicy,
  isBusy: boolean
): QueueDecision {
  if (!isBusy) return "start";
  switch (policy) {
    case "queue":
      return "enqueue";
    case "interrupt":
    case "replace":
      return "replace";
    case "ignore":
      return "drop";
    case "coexist":
      return "start";
  }
}

export interface AcceptTriggerParams {
  rule: TriggerRule;
  effect: EffectConfig;
  source: z.infer<typeof TriggerSourceSchema>;
  now?: number;
  lastFiredAt?: number | null;
}

export function shouldAcceptTrigger({
  rule,
  effect,
  source,
  now = Date.now(),
  lastFiredAt = null,
}: AcceptTriggerParams): { accept: boolean; reason: string } {
  if (!rule.enabled || !effect.enabled) {
    return { accept: false, reason: "disabled" };
  }
  if (!rule.allowedSources.includes(source)) {
    return { accept: false, reason: "source-not-allowed" };
  }
  const cooldownMs = rule.cooldownMs ?? effect.cooldownMs;
  if (lastFiredAt !== null && now - lastFiredAt < cooldownMs) {
    return { accept: false, reason: "cooldown" };
  }
  return { accept: true, reason: "ok" };
}

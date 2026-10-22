import { z } from "zod/v4";
import { MomentTypeSchema } from "../templates/schemas";
import type { Template } from "../templates/schemas";
import { TriggerSourceSchema } from "../trigger/triggerSchemas";

/**
 * M2 shared effect contracts, extended in M3 with media kinds.
 *
 * V1 `frame` behaviour is unchanged (static PNG composition in the desktop
 * app). The `image` / `video` / `audio` / `cutaway` / `popup` kinds target
 * the OBS overlay renderer: the relay validates them, the overlay plays
 * them. The desktop PNG path ignores kinds it cannot compose.
 */

export const EffectKindSchema = z.enum([
  "frame",
  "image",
  "video",
  "audio",
  "cutaway",
  "popup",
]);
export type EffectKind = z.infer<typeof EffectKindSchema>;

export const QueuePolicySchema = z.enum([
  "queue",
  "interrupt",
  "replace",
  "ignore",
  "coexist",
]);
export type QueuePolicy = z.infer<typeof QueuePolicySchema>;

/** Relay-safe media filename: basename, no traversal, allowlisted extension. */
const MEDIA_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mp3",
  ".ogg",
  ".wav",
] as const;

export const MediaFileSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Must be a plain filename, not a path.")
  .refine(
    (name) => {
      const dot = name.lastIndexOf(".");
      if (dot < 0) return false;
      const ext = name.slice(dot).toLowerCase();
      return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
    },
    { message: "Unsupported media extension." }
  );

export type MediaFile = z.infer<typeof MediaFileSchema>;

export function mediaKindForFile(name: string): "image" | "video" | "audio" | null {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".ogg", ".wav"].includes(ext)) return "audio";
  return null;
}

export const PositionSchema = z.enum([
  "center",
  "fullscreen",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
export type EffectPosition = z.infer<typeof PositionSchema>;

export const EntranceSchema = z.enum(["pop", "fade", "slide-up", "none"]);
export type Entrance = z.infer<typeof EntranceSchema>;

const MediaBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  moment: MomentTypeSchema,
  /** Playback window; the overlay auto-cleans after this elapses. */
  durationMs: z.number().int().min(250).max(30000).default(2700),
  delayMs: z.number().int().min(0).max(10000).default(0),
  cooldownMs: z.number().int().min(0).max(60000).default(4000),
  priority: z.number().int().min(0).max(100).default(50),
  queue: QueuePolicySchema.default("replace"),
  enabled: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(1),
  position: PositionSchema.default("center"),
  entrance: EntranceSchema.default("pop"),
  exit: EntranceSchema.default("fade"),
});

/** V1 PNG frame composition (desktop canvas path). */
export const FrameEffectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("frame"),
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
  /** Reserved overlay layering; validated but unused by V1 PNG path. */
  zIndex: z.number().int().min(0).max(9999).default(100),
  opacity: z.number().min(0).max(1).default(1),
});

export const ImageEffectSchema = MediaBaseSchema.extend({
  kind: z.literal("image"),
  mediaFile: MediaFileSchema,
});

export const VideoEffectSchema = MediaBaseSchema.extend({
  kind: z.literal("video"),
  mediaFile: MediaFileSchema,
  /** Trim points in ms; clipEnd must exceed clipStart when both set. */
  clipStartMs: z.number().int().min(0).max(600000).optional(),
  clipEndMs: z.number().int().min(1).max(600000).optional(),
  muted: z.boolean().default(false),
}).refine(
  (v) =>
    v.clipStartMs === undefined ||
    v.clipEndMs === undefined ||
    v.clipEndMs > v.clipStartMs,
  { message: "clipEndMs must exceed clipStartMs." }
);

export const AudioEffectSchema = MediaBaseSchema.extend({
  kind: z.literal("audio"),
  mediaFile: MediaFileSchema,
  /** Optional still shown behind audio; falls back to the moment template. */
  templateId: z.string().min(1).optional(),
});

export const CutawayEffectSchema = MediaBaseSchema.extend({
  kind: z.literal("cutaway"),
  mediaFile: MediaFileSchema,
  clipStartMs: z.number().int().min(0).max(600000).optional(),
  clipEndMs: z.number().int().min(1).max(600000).optional(),
  muted: z.boolean().default(false),
}).refine(
  (v) =>
    v.clipStartMs === undefined ||
    v.clipEndMs === undefined ||
    v.clipEndMs > v.clipStartMs,
  { message: "clipEndMs must exceed clipStartMs." }
);

export const PopupEffectSchema = MediaBaseSchema.extend({
  kind: z.literal("popup"),
  mediaFile: MediaFileSchema.optional(),
  templateId: z.string().min(1).optional(),
}).refine((p) => p.mediaFile !== undefined || p.templateId !== undefined, {
  message: "Popup needs a mediaFile or a templateId.",
});

export const AnyEffectSchema = z.discriminatedUnion("kind", [
  FrameEffectSchema,
  ImageEffectSchema,
  VideoEffectSchema,
  AudioEffectSchema,
  CutawayEffectSchema,
  PopupEffectSchema,
]);

export type FrameEffect = z.infer<typeof FrameEffectSchema>;
export type ImageEffect = z.infer<typeof ImageEffectSchema>;
export type VideoEffect = z.infer<typeof VideoEffectSchema>;
export type AudioEffect = z.infer<typeof AudioEffectSchema>;
export type CutawayEffect = z.infer<typeof CutawayEffectSchema>;
export type PopupEffect = z.infer<typeof PopupEffectSchema>;
export type AnyEffect = z.infer<typeof AnyEffectSchema>;

/**
 * Backwards-compatible alias: code written against the M2 single-shape
 * `EffectConfig` keeps working — it is exactly the V1 frame effect.
 */
export const EffectConfigSchema = FrameEffectSchema;
export type EffectConfig = FrameEffect;

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

/** Parse any M3 effect kind (frame/image/video/audio/cutaway/popup). */
export function parseAnyEffect(data: unknown): AnyEffect {
  return AnyEffectSchema.parse(data);
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

import { z } from "zod/v4";

export const PACK_VERSION = 1;

/** Server-side mirror of the local pack contract (v1). Local JSON must validate here unchanged. */
const MomentSchema = z.enum(["wow", "funny", "sad"]);
const SourceSchema = z.enum(["ai-detector", "manual", "timer", "hotkey", "api"]);

const BaseEffect = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  moment: MomentSchema,
  durationMs: z.number().int().min(250).max(30000),
  delayMs: z.number().int().min(0).max(10000).default(0),
  cooldownMs: z.number().int().min(0).max(60000).default(0),
  priority: z.number().int().min(0).max(100).default(50),
  queue: z.enum(["queue", "interrupt", "replace", "ignore", "coexist"]).default("replace"),
  enabled: z.boolean().default(true),
});

const FrameEffect = BaseEffect.extend({
  kind: z.literal("frame"),
  templateId: z.string().min(1).max(64),
  zIndex: z.number().int().min(0).max(9999).default(100),
  opacity: z.number().min(0).max(1).default(1),
});

const MediaBase = BaseEffect.extend({
  mediaFile: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  volume: z.number().min(0).max(1).default(1),
  position: z.enum(["center", "fullscreen", "top-left", "top-right", "bottom-left", "bottom-right"]).default("center"),
  entrance: z.enum(["pop", "fade", "slide-up", "none"]).default("pop"),
  exit: z.enum(["pop", "fade", "slide-up", "none"]).default("fade"),
});

const ImageEffect = MediaBase.extend({ kind: z.literal("image") });
const VideoEffect = MediaBase.extend({
  kind: z.literal("video"),
  clipStartMs: z.number().int().min(0).max(600000).optional(),
  clipEndMs: z.number().int().min(1).max(600000).optional(),
  muted: z.boolean().default(false),
});
const AudioEffect = MediaBase.extend({
  kind: z.literal("audio"),
  templateId: z.string().min(1).max(64).optional(),
  muted: z.boolean().default(false),
});
const CutawayEffect = MediaBase.extend({
  kind: z.literal("cutaway"),
  clipStartMs: z.number().int().min(0).max(600000).optional(),
  clipEndMs: z.number().int().min(1).max(600000).optional(),
  muted: z.boolean().default(false),
});
const PopupEffect = MediaBase.extend({
  kind: z.literal("popup"),
  templateId: z.string().min(1).max(64).optional(),
}).refine((e) => Boolean(e.templateId) || Boolean(e.mediaFile), { message: "popup needs templateId or mediaFile" });

const AnyEffect = z.discriminatedUnion("kind", [FrameEffect, ImageEffect, VideoEffect, AudioEffect, CutawayEffect, PopupEffect]);
export type ServerEffect = z.infer<typeof AnyEffect>;

const AssignmentSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  moment: MomentSchema.optional(),
  effectId: z.string().min(1),
});
export type ServerAssignment = z.infer<typeof AssignmentSchema>;

const StepSchema = z.object({
  id: z.string().min(1),
  effectId: z.string().min(1),
  delayMs: z.number().int().min(0).max(30000).default(0),
});

export const ServerPackSchema = z.object({
  version: z.literal(PACK_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  effects: z.array(AnyEffect).max(100),
  assignments: z.array(AssignmentSchema).max(100),
  sequence: z.array(StepSchema).max(100),
});
export type ServerPack = z.infer<typeof ServerPackSchema>;

export function parseServerPack(data: unknown): ServerPack {
  const pack = ServerPackSchema.parse(data);
  assertServerPackIntegrity(pack);
  return pack;
}

export function assertServerPackIntegrity(pack: ServerPack): void {
  const ids = new Set(pack.effects.map((e) => e.id));
  for (const a of pack.assignments) {
    if (!ids.has(a.effectId)) throw new Error(`Assignment "${a.id}" points at missing effect "${a.effectId}".`);
  }
  for (const s of pack.sequence) {
    if (!ids.has(s.effectId)) throw new Error(`Sequence step "${s.id}" points at missing effect "${s.effectId}".`);
  }
  const seen = new Set<string>();
  for (const e of pack.effects) {
    if (seen.has(e.id)) throw new Error(`Duplicate effect ID: "${e.id}".`);
    seen.add(e.id);
  }
  for (const e of pack.effects) {
    if ((e.kind === "video" || e.kind === "cutaway") && e.clipStartMs !== undefined && e.clipEndMs !== undefined && e.clipEndMs <= e.clipStartMs) {
      throw new Error(`Effect "${e.id}": clipEndMs must exceed clipStartMs.`);
    }
  }
}

/** Normalize a validated pack into child rows (effects/assignments/sequence). */
export function normalizePack(pack: ServerPack): {
  effects: Array<{ effectUid: string; kind: string; name: string; moment: string; data: unknown }>;
  assignments: Array<{ assignmentUid: string; source: string; moment: string | null; effectUid: string }>;
  steps: Array<{ stepUid: string; effectUid: string; position: number; delayMs: number }>;
} {
  return {
    effects: pack.effects.map((e) => ({ effectUid: e.id, kind: e.kind, name: e.name, moment: e.moment, data: e })),
    assignments: pack.assignments.map((a) => ({ assignmentUid: a.id, source: a.source, moment: a.moment ?? null, effectUid: a.effectId })),
    steps: pack.sequence.map((s, i) => ({ stepUid: s.id, effectUid: s.effectId, position: i, delayMs: s.delayMs })),
  };
}

/** Import with collision-safe UID handling; mirrors the local importPack rule. */
export function importServerPack(data: unknown, existingEffectUids: Set<string>, existingPackUids: Set<string>): ServerPack {
  const pack = parseServerPack(data);
  const remap = new Map<string, string>();
  for (const e of pack.effects) {
    if (existingEffectUids.has(e.id) || remap.has(e.id)) {
      let n = 2;
      let candidate = `${e.id}-imported-${n}`;
      while (existingEffectUids.has(candidate) || [...remap.values()].includes(candidate)) {
        n += 1;
        candidate = `${e.id}-imported-${n}`;
      }
      remap.set(e.id, candidate);
    }
  }
  let id = pack.id;
  let name = pack.name;
  if (existingPackUids.has(pack.id)) {
    id = `pack-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    name = `${pack.name} (imported)`.slice(0, 80);
  }
  if (remap.size === 0 && id === pack.id) return pack;
  const rewrite = (uid: string): string => remap.get(uid) ?? uid;
  return parseServerPack({
    ...pack,
    id,
    name,
    effects: pack.effects.map((e) => ({ ...e, id: rewrite(e.id) })),
    assignments: pack.assignments.map((a) => ({ ...a, effectId: rewrite(a.effectId) })),
    sequence: pack.sequence.map((s) => ({ ...s, effectId: rewrite(s.effectId) })),
  });
}

import { z } from "zod/v4";
import {
  AnyEffectSchema,
} from "../effects/effectSchemas";
import { MomentTypeSchema } from "../templates/schemas";
import { TriggerSourceSchema } from "../trigger/triggerSchemas";

export const PACK_VERSION = 1;

/**
 * Versioned reaction pack. Effects embed their full validated config;
 * media lives outside the pack as filenames resolved against the relay
 * media directory at publish time — never as binaries in storage.
 */
export const TriggerAssignmentSchema = z.object({
  id: z.string().min(1),
  source: TriggerSourceSchema,
  /** Moment that fires the effect (ai-detector/timer/hotkey sources). */
  moment: MomentTypeSchema.optional(),
  effectId: z.string().min(1),
});

export type TriggerAssignment = z.infer<typeof TriggerAssignmentSchema>;

export const SequenceStepSchema = z.object({
  id: z.string().min(1),
  effectId: z.string().min(1),
  /** Pause after the previous step ends before this step starts. */
  delayMs: z.number().int().min(0).max(30000).default(0),
});

export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const ReactionPackSchema = z.object({
  version: z.literal(PACK_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  effects: z.array(AnyEffectSchema).max(100),
  assignments: z.array(TriggerAssignmentSchema).max(100),
  sequence: z.array(SequenceStepSchema).max(100),
});

export type ReactionPack = z.infer<typeof ReactionPackSchema>;

export function parsePack(data: unknown): ReactionPack {
  const pack = ReactionPackSchema.parse(data);
  assertPackIntegrity(pack);
  return pack;
}

/** Referential integrity: assignments/steps must point at pack effects. */
export function assertPackIntegrity(pack: ReactionPack): void {
  const ids = new Set(pack.effects.map((e) => e.id));
  for (const a of pack.assignments) {
    if (!ids.has(a.effectId)) {
      throw new Error(
        `Assignment "${a.id}" points at missing effect "${a.effectId}".`
      );
    }
  }
  for (const s of pack.sequence) {
    if (!ids.has(s.effectId)) {
      throw new Error(
        `Sequence step "${s.id}" points at missing effect "${s.effectId}".`
      );
    }
  }
  const effectIds = new Set<string>();
  for (const e of pack.effects) {
    if (effectIds.has(e.id)) throw new Error(`Duplicate effect ID: "${e.id}".`);
    effectIds.add(e.id);
  }
}

let packCounter = 0;

export function generatePackId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `pack-${c.randomUUID()}`;
  packCounter += 1;
  return `pack-${Date.now()}-${packCounter}`;
}

export function createPack(name: string): ReactionPack {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Pack name must not be empty.");
  return {
    version: PACK_VERSION,
    id: generatePackId(),
    name: trimmed,
    effects: [],
    assignments: [],
    sequence: [],
  };
}

export function renamePack(pack: ReactionPack, name: string): ReactionPack {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Pack name must not be empty.");
  return { ...pack, name: trimmed.slice(0, 80) };
}

export function duplicatePack(pack: ReactionPack, name?: string): ReactionPack {
  const copy = structuredClone(pack);
  copy.id = generatePackId();
  copy.name = (name ?? `${pack.name} copy`).trim().slice(0, 80) || `${pack.name} copy`;
  return parsePack(copy);
}

/** Serialize for save/export. Binaries are never embedded — see packStore. */
export function serializePack(pack: ReactionPack): string {
  return JSON.stringify(parsePack(pack));
}

export interface ImportCollisionSets {
  packIds: Set<string>;
  effectIds?: Set<string>;
}

/**
 * Deserialize imported data. Colliding ids are rewritten safely:
 * - duplicate effect ids take `-imported-N` ids with all assignment and
 *   sequence references rewritten, preserving integrity;
 * - a duplicate pack id takes a fresh id (and an "(imported)" name suffix),
 *   so importing the same file twice never yields duplicate pack IDs.
 */
export function importPack(data: unknown, existing: ImportCollisionSets): ReactionPack {
  const pack = parsePack(data);
  const effectIds = existing.effectIds ?? new Set<string>();
  const reserved = new Set([...effectIds, ...pack.effects.map((effect) => effect.id)]);
  const idMap = new Map<string, string>();
  for (const effect of pack.effects) {
    if (effectIds.has(effect.id) || idMap.has(effect.id)) {
      let n = 2;
      let candidate = `${effect.id}-imported-${n}`;
      while (reserved.has(candidate)) {
        n += 1;
        candidate = `${effect.id}-imported-${n}`;
      }
      idMap.set(effect.id, candidate);
      reserved.add(candidate);
    }
  }
  let id = pack.id;
  let name = pack.name;
  if (existing.packIds.has(pack.id)) {
    id = generatePackId();
    name = `${pack.name} (imported)`.slice(0, 80);
  }
  if (idMap.size === 0 && id === pack.id) return pack;
  const rewrite = (effectId: string): string => idMap.get(effectId) ?? effectId;
  return parsePack({
    ...pack,
    id,
    name,
    effects: pack.effects.map((e) => ({ ...e, id: rewrite(e.id) })),
    assignments: pack.assignments.map((a) => ({ ...a, effectId: rewrite(a.effectId) })),
    sequence: pack.sequence.map((s) => ({ ...s, effectId: rewrite(s.effectId) })),
  });
}

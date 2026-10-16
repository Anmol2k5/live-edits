import {
  getEffectById as getStaticEffectById,
  pickRandomEffect as pickStaticRandomEffect,
} from "../effects/registry";
import { getTemplateById } from "../templates/templates";
import type { Template } from "../templates/schemas";
import type { AnyEffect, EffectConfig } from "../effects/effectSchemas";
import type { MomentType } from "../detector/MomentDetector";
import type { TriggerSource } from "../trigger/triggerSchemas";
import type { ReactionPack } from "./packSchemas";

/**
 * Pack-aware effect resolution. The active pack wins; the static V1 registry
 * is the fallback so every pre-pack flow behaves exactly as before when no
 * pack (or no matching assignment) exists.
 */

export function resolveEffectById(
  effectId: string,
  pack?: ReactionPack | null
): AnyEffect | EffectConfig {
  const fromPack = pack?.effects.find((e) => e.id === effectId);
  if (fromPack) return fromPack;
  return getStaticEffectById(effectId);
}

/**
 * The single matching rule every trigger source shares: first pack
 * assignment with equal source and equal moment whose effect is enabled
 * wins. Assignments without a moment are wildcards: they match any moment
 * for their source but only after exact matches, so timer/hotkey "play
 * this regardless" entries work without shadowing specific moment rules.
 * Returns null when nothing matches (caller falls back to V1).
 */
export function findAssignment(
  moment: MomentType,
  source: TriggerSource,
  pack?: ReactionPack | null
): AnyEffect | null {
  if (!pack) return null;
  for (const assignment of pack.assignments) {
    if (assignment.source !== source) continue;
    if (assignment.moment !== moment) continue;
    const effect = pack.effects.find((e) => e.id === assignment.effectId);
    if (effect && effect.enabled) return effect;
  }
  for (const assignment of pack.assignments) {
    if (assignment.source !== source) continue;
    if (assignment.moment !== undefined) continue;
    const effect = pack.effects.find((e) => e.id === assignment.effectId);
    if (effect && effect.enabled) return effect;
  }
  return null;
}

export type TemplateResolution =
  | { kind: "frame"; template: Template }
  | { kind: "media"; effect: AnyEffect }
  | { kind: "static"; template: Template };

/**
 * Shared template-trigger rule: a pack assignment for (source, moment)
 * selects the assigned frame template or routes to the assigned media
 * effect; otherwise the requested template plays unchanged (V1).
 */
export function resolveTemplateTrigger(
  templateId: string,
  source: TriggerSource,
  pack?: ReactionPack | null
): TemplateResolution {
  const template = getTemplateById(templateId);
  const assigned = findAssignment(template.moment, source, pack);
  if (!assigned) return { kind: "static", template };
  if (assigned.kind === "frame") {
    return { kind: "frame", template: getTemplateById(assigned.templateId) };
  }
  return { kind: "media", effect: assigned };
}

/**
 * Resolve a moment trigger to the effect that should play. Pack assignments
 * matching (source, moment) win in pack order; otherwise the static random
 * template pick (V1 behaviour) applies. Returns null only when nothing is
 * enabled anywhere.
 */
export function resolveMomentToEffect(
  moment: MomentType,
  source: TriggerSource,
  pack?: ReactionPack | null,
  random: () => number = Math.random
): AnyEffect | EffectConfig | null {
  return findAssignment(moment, source, pack) ?? pickStaticRandomEffect(moment, random);
}

/**
 * Template art for an effect, when it has any. Frame effects always do;
 * popup/audio effects may carry one for fallback art; pure media effects
 * return null and callers fall back to the moment's default template.
 */
export function resolveTemplateForEffect(
  effect: AnyEffect | EffectConfig
): Template | null {
  if (effect.kind === "frame") {
    return getTemplateById(effect.templateId);
  }
  if (
    (effect.kind === "popup" || effect.kind === "audio") &&
    effect.templateId
  ) {
    return getTemplateById(effect.templateId);
  }
  return null;
}

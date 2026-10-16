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
  if (pack) {
    for (const assignment of pack.assignments) {
      if (assignment.source !== source || assignment.moment !== moment) continue;
      const effect = pack.effects.find((e) => e.id === assignment.effectId);
      if (effect && effect.enabled) return effect;
    }
  }
  return pickStaticRandomEffect(moment, random);
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

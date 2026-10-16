import { TEMPLATES, getTemplateById } from "../templates/templates";
import type { Template } from "../templates/schemas";
import {
  templateToEffect,
  type EffectConfig,
} from "./effectSchemas";
import type { MomentType } from "../detector/MomentDetector";

/**
 * M2 template-backed effect registry.
 *
 * The 6 PNG templates ARE the V1 effect library. Each template maps 1:1 to
 * an `EffectConfig` (`effect-<templateId>`), so the pipeline can resolve
 * moment/template/effect triggers through one validated path while the
 * canvas composer stays untouched until M3.
 */

export const EFFECTS: EffectConfig[] = TEMPLATES.map(templateToEffect);

const EFFECT_IDS = EFFECTS.map((e) => e.id);

export function getEffectById(id: string): EffectConfig {
  const found = EFFECTS.find((e) => e.id === id);
  if (!found) {
    throw new Error(
      `Unknown effect ID: "${id}". Known: ${EFFECT_IDS.join(", ")}`
    );
  }
  return found;
}

export function getEffectsForMoment(moment: MomentType): EffectConfig[] {
  return EFFECTS.filter((e) => e.moment === moment);
}

export function getTemplateForEffect(effect: EffectConfig): Template {
  return getTemplateById(effect.templateId);
}

/**
 * Random pick with an injectable source so tests stay deterministic.
 * Returns null when no enabled effect matches (caller must handle "no-op").
 */
export function pickRandomEffect(
  moment: MomentType,
  random: () => number = Math.random
): EffectConfig | null {
  const candidates = getEffectsForMoment(moment).filter((e) => e.enabled);
  if (candidates.length === 0) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[Math.min(index, candidates.length - 1)];
}

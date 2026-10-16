import { describe, it, expect } from "vitest";
import {
  templateToEffect,
  parseEffectConfig,
  decideQueueAction,
  shouldAcceptTrigger,
  isEffectInCooldown,
  parseTriggerRule,
} from "../effectSchemas";
import { TEMPLATES } from "../../templates/templates";

describe("effect contracts (M2)", () => {
  it("maps every template 1:1 to a validated effect", () => {
    expect(TEMPLATES).toHaveLength(6);
    for (const t of TEMPLATES) {
      const e = templateToEffect(t);
      expect(e.id).toBe(`effect-${t.id}`);
      expect(e.templateId).toBe(t.id);
      expect(e.moment).toBe(t.moment);
      expect(e.enabled).toBe(true);
      expect(parseEffectConfig(e)).toEqual(e);
    }
  });

  it("rejects out-of-range timing/priority", () => {
    const base = templateToEffect(TEMPLATES[0]);
    expect(() => parseEffectConfig({ ...base, durationMs: 0 })).toThrow();
    expect(() => parseEffectConfig({ ...base, priority: 101 })).toThrow();
    expect(() => parseEffectConfig({ ...base, queue: "explode" })).toThrow();
  });

  it("decides the §6 queue matrix", () => {
    expect(decideQueueAction("queue", false)).toBe("start");
    expect(decideQueueAction("queue", true)).toBe("enqueue");
    expect(decideQueueAction("interrupt", true)).toBe("replace");
    expect(decideQueueAction("replace", true)).toBe("replace");
    expect(decideQueueAction("ignore", true)).toBe("drop");
    expect(decideQueueAction("coexist", true)).toBe("start");
  });

  it("gates triggers on enabled/source/cooldown", () => {
    const effect = templateToEffect(TEMPLATES[0]);
    const rule = parseTriggerRule({ effectId: effect.id });
    expect(
      shouldAcceptTrigger({ rule, effect, source: "manual", now: 5000, lastFiredAt: null }).accept
    ).toBe(true);
    expect(
      shouldAcceptTrigger({
        rule: { ...rule, enabled: false },
        effect,
        source: "manual",
      }).reason
    ).toBe("disabled");
    expect(
      shouldAcceptTrigger({
        rule: { ...rule, allowedSources: ["manual"] },
        effect,
        source: "timer",
      }).reason
    ).toBe("source-not-allowed");
    expect(
      shouldAcceptTrigger({ rule, effect, source: "manual", now: 5000, lastFiredAt: 2000 }).reason
    ).toBe("cooldown");
    expect(
      shouldAcceptTrigger({ rule, effect, source: "manual", now: 9000, lastFiredAt: 2000 }).accept
    ).toBe(true);
  });

  it("checks effect cooldown windows", () => {
    const effect = templateToEffect(TEMPLATES[0]);
    expect(isEffectInCooldown(effect, null, 1000)).toBe(false);
    expect(isEffectInCooldown(effect, 1000, 1000 + effect.cooldownMs - 1)).toBe(true);
    expect(isEffectInCooldown(effect, 1000, 1000 + effect.cooldownMs)).toBe(false);
  });
});

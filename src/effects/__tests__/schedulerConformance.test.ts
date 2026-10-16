import { describe, it, expect } from "vitest";
import cases from "../../../shared/scheduler-cases.json";
import { EffectScheduler } from "../scheduler";

interface CaseStep {
  effect: {
    id: string;
    enabled: boolean;
    priority: number;
    queue: "queue" | "interrupt" | "replace" | "ignore" | "coexist";
    cooldownMs: number;
  };
  trigger: { id: string; dedupKey?: string; expiresAt?: number };
  now: number;
  expect: { action: string; reason: string; preemptedEffectId?: string };
}

interface Case {
  name: string;
  options?: { maxQueue?: number; dedupSize?: number };
  steps: CaseStep[];
  expectQueue?: string[];
  expectPlaying?: string;
}

/**
 * Shared conformance: identical scenarios also run against the raw core in
 * node:test (`scripts/scheduler-conformance.test.mjs`). Both harnesses must
 * agree — the OBS overlay player loads the same core over HTTP.
 */
describe("scheduler conformance (shared cases)", () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(c.name, () => {
      const scheduler = new EffectScheduler(c.options ?? {});
      for (const step of c.steps) {
        const result = scheduler.submit(step.effect, step.trigger, step.now);
        expect(result.action).toBe(step.expect.action);
        expect(result.reason).toBe(step.expect.reason);
        if (step.expect.preemptedEffectId !== undefined) {
          expect(result.preempted?.effectId).toBe(step.expect.preemptedEffectId);
        }
      }
      if (c.expectQueue !== undefined) {
        expect(scheduler.queued.map((q) => q.effectId)).toEqual(c.expectQueue);
      }
      if (c.expectPlaying !== undefined) {
        expect(scheduler.playing?.effectId).toBe(c.expectPlaying);
      }
    });
  }
});

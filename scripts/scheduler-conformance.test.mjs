import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/effects/scheduler-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const { createScheduler } = globalThis.LiveEditsScheduler ?? {};
assert.ok(createScheduler, "shared scheduler core failed to initialise");

const cases = JSON.parse(
  await readFile(resolve(HERE, "..", "shared", "scheduler-cases.json"), "utf8")
);

/**
 * Shared conformance: identical scenarios also run in vitest against the
 * typed wrapper (`src/effects/__tests__/schedulerConformance.test.ts`).
 */
for (const c of cases.cases) {
  test(`scheduler conformance: ${c.name}`, () => {
    const scheduler = createScheduler(c.options ?? {});
    for (const step of c.steps) {
      const result = scheduler.submit(step.effect, step.trigger, step.now);
      assert.equal(result.action, step.expect.action, JSON.stringify(step));
      assert.equal(result.reason, step.expect.reason, JSON.stringify(step));
      if (step.expect.preemptedEffectId !== undefined) {
        assert.equal(result.preempted?.effectId, step.expect.preemptedEffectId);
      }
    }
    if (c.expectQueue !== undefined) {
      assert.deepEqual(
        scheduler.queued().map((q) => q.effectId),
        c.expectQueue
      );
    }
    if (c.expectPlaying !== undefined) {
      assert.equal(scheduler.playing()?.effectId, c.expectPlaying);
    }
  });
}

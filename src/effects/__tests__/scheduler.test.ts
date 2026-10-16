import { describe, it, expect } from "vitest";
import { EffectScheduler } from "../scheduler";
import type { AnyEffect } from "../effectSchemas";

function effect(
  overrides: Partial<Extract<AnyEffect, { kind: "video" }>> & { id: string } = { id: "e1" }
): AnyEffect {
  return {
    kind: "video",
    name: "clip",
    mediaFile: "clip.webm",
    moment: "wow",
    durationMs: 2700,
    delayMs: 0,
    cooldownMs: 4000,
    priority: 50,
    queue: "replace",
    enabled: true,
    volume: 1,
    position: "center",
    entrance: "pop",
    exit: "fade",
    muted: false,
    ...overrides,
  } as AnyEffect;
}

describe("EffectScheduler (M3)", () => {
  it("starts when idle and promotes queued items on finish", () => {
    const s = new EffectScheduler({ maxQueue: 6 });
    const first = s.submit(
      effect({ id: "a", queue: "queue", cooldownMs: 0 }),
      { id: "t1" },
      1000
    );
    expect(first.action).toBe("start");
    const second = s.submit(
      effect({ id: "b", queue: "queue", cooldownMs: 0 }),
      { id: "t2" },
      1100
    );
    expect(second.action).toBe("enqueue");
    expect(s.queueLength).toBe(1);
    const next = s.finish(s.playing?.key);
    expect(next?.effectId).toBe("b");
    expect(s.queueLength).toBe(0);
  });

  it("obeys replace/interrupt/ignore policies while busy", () => {
    const s = new EffectScheduler();
    s.submit(effect({ id: "a", queue: "queue", cooldownMs: 0 }), { id: "t1" }, 1000);
    expect(
      s.submit(effect({ id: "b", queue: "ignore", cooldownMs: 0 }), { id: "t2" }, 1100).action
    ).toBe("drop");
    const replaced = s.submit(
      effect({ id: "c", queue: "replace", cooldownMs: 0 }),
      { id: "t3" },
      1200
    );
    expect(replaced.action).toBe("replace");
    expect(replaced.preempted?.effectId).toBe("a");
    expect(s.playing?.effectId).toBe("c");
    const interrupted = s.submit(
      effect({ id: "d", queue: "interrupt", cooldownMs: 0 }),
      { id: "t4" },
      1300
    );
    expect(interrupted.action).toBe("replace");
    expect(s.playing?.effectId).toBe("d");
  });

  it("orders the waiting queue by priority (stable)", () => {
    const s = new EffectScheduler();
    s.submit(effect({ id: "main", queue: "queue", cooldownMs: 0 }), { id: "t0" }, 1000);
    s.submit(effect({ id: "low", queue: "queue", priority: 10, cooldownMs: 0 }), { id: "t1" }, 1100);
    s.submit(effect({ id: "high", queue: "queue", priority: 90, cooldownMs: 0 }), { id: "t2" }, 1200);
    expect(s.queued.map((q) => q.effectId)).toEqual(["high", "low"]);
  });

  it("drops expired and duplicate triggers", () => {
    const s = new EffectScheduler();
    expect(
      s.submit(effect({ id: "a", cooldownMs: 0 }), { id: "t1", expiresAt: 1500 }, 2000).reason
    ).toBe("expired");
    expect(
      s.submit(effect({ id: "a", cooldownMs: 0 }), { id: "same" }, 2000).action
    ).toBe("start");
    expect(
      s.submit(effect({ id: "b", cooldownMs: 0 }), { id: "same" }, 2100).reason
    ).toBe("duplicate");
  });

  it("enforces per-effect cooldowns", () => {
    const s = new EffectScheduler();
    s.submit(effect({ id: "a", cooldownMs: 4000 }), { id: "t1" }, 1000);
    s.finish();
    expect(
      s.submit(effect({ id: "a", cooldownMs: 4000 }), { id: "t2" }, 2000).reason
    ).toBe("cooldown");
    expect(
      s.submit(effect({ id: "a", cooldownMs: 4000 }), { id: "t3" }, 5000).action
    ).toBe("start");
  });

  it("bounds the waiting queue and survives a 1000-submit burst", () => {
    const s = new EffectScheduler({ maxQueue: 6 });
    s.submit(effect({ id: "main", queue: "queue", cooldownMs: 0 }), { id: "t0" }, 0);
    let drops = 0;
    for (let i = 1; i <= 1000; i += 1) {
      const r = s.submit(
        effect({ id: `e${i}`, queue: "queue", cooldownMs: 0 }),
        { id: `t${i}` },
        i
      );
      if (r.action === "drop") drops += 1;
    }
    expect(s.queueLength).toBeLessThanOrEqual(6);
    expect(drops).toBeGreaterThan(900);
  });

  it("clears all state on demand", () => {
    const s = new EffectScheduler();
    s.submit(effect({ id: "a", queue: "queue", cooldownMs: 0 }), { id: "t1" }, 1000);
    s.submit(effect({ id: "b", queue: "queue", cooldownMs: 0 }), { id: "t2" }, 1100);
    s.clear();
    expect(s.playing).toBeNull();
    expect(s.queueLength).toBe(0);
  });
});

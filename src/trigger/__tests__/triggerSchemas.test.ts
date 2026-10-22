import { describe, it, expect } from "vitest";
import {
  parseTriggerEvent,
  isTriggerContractEvent,
  createMomentTrigger,
  createTemplateTrigger,
  createEffectTrigger,
  toLegacyTrigger,
  fromLegacyTrigger,
  isExpired,
  TriggerDeduper,
  generateTriggerId,
} from "../triggerSchemas";

describe("trigger contracts (M2)", () => {
  it("creates a valid moment trigger with generated id/timestamp", () => {
    const e = createMomentTrigger("wow", { source: "ai-detector", confidence: 0.9 });
    expect(e.triggerType).toBe("moment");
    expect(e.moment).toBe("wow");
    expect(e.id.length).toBeGreaterThan(0);
    expect(e.timestamp).toBeGreaterThan(0);
    expect(isTriggerContractEvent(e)).toBe(true);
    expect(parseTriggerEvent(e)).toEqual(e);
  });

  it("rejects confidence outside 0..1", () => {
    const e = createMomentTrigger("wow", { source: "ai-detector", confidence: 1.5 });
    expect(isTriggerContractEvent(e)).toBe(false);
    expect(() => parseTriggerEvent(e)).toThrow();
  });

  it("rejects expiresAt at or before timestamp", () => {
    const base = createTemplateTrigger("wow-1", { source: "manual", timestamp: 2000 });
    expect(() =>
      parseTriggerEvent({ ...base, expiresAt: 2000 })
    ).toThrow();
    expect(() =>
      parseTriggerEvent({ ...base, expiresAt: 1999 })
    ).toThrow();
    expect(parseTriggerEvent({ ...base, expiresAt: 2001 }).expiresAt).toBe(2001);
  });

  it("rejects unknown sources and empty ids", () => {
    const e = createTemplateTrigger("wow-1", { source: "manual" });
    expect(() =>
      parseTriggerEvent({ ...e, source: "twitch" })
    ).toThrow();
    expect(() => parseTriggerEvent({ ...e, id: "" })).toThrow();
  });

  it("round-trips legacy ai-detector and manual events", () => {
    const legacyAi = { source: "ai-detector" as const, moment: "sad" as const, confidence: 0.9, at: 1234 };
    const contract = fromLegacyTrigger(legacyAi);
    expect(contract.triggerType).toBe("moment");
    expect(toLegacyTrigger(contract)).toEqual(legacyAi);

    const legacyManual = { source: "manual" as const, templateId: "funny-2", at: 5678 };
    const contract2 = fromLegacyTrigger(legacyManual);
    expect(contract2.triggerType).toBe("template");
    expect(toLegacyTrigger(contract2)).toEqual(legacyManual);
  });

  it("refuses legacy conversion for effect triggers (needs registry)", () => {
    const e = createEffectTrigger("effect-wow-1", { source: "manual" });
    expect(() => toLegacyTrigger(e)).toThrow(/registry/);
  });

  it("detects expiry", () => {
    const e = createTemplateTrigger("wow-1", {
      source: "manual",
      timestamp: 1000,
      expiresAt: 1500,
    });
    expect(isExpired(e, 1400)).toBe(false);
    expect(isExpired(e, 1501)).toBe(true);
    expect(isExpired(createTemplateTrigger("wow-1", { source: "manual" }), Date.now() + 1000)).toBe(false);
  });

  it("deduper accepts first sighting and rejects repeats with a bound", () => {
    const d = new TriggerDeduper(3);
    const a = createTemplateTrigger("wow-1", { source: "manual", id: "a" });
    const b = createTemplateTrigger("wow-1", { source: "manual", id: "b" });
    expect(d.checkAndAdd(a)).toBe(true);
    expect(d.checkAndAdd(a)).toBe(false);
    expect(d.checkAndAdd(b)).toBe(true);
    d.checkAndAdd(createTemplateTrigger("wow-1", { source: "manual", id: "c" }));
    d.checkAndAdd(createTemplateTrigger("wow-1", { source: "manual", id: "d" }));
    expect(d.size).toBeLessThanOrEqual(3);
  });

  it("dedupKey aliases the same logical event across relays", () => {
    const d = new TriggerDeduper();
    const first = createTemplateTrigger("wow-1", { source: "api", dedupKey: "twitch-ev-1" });
    const replay = createTemplateTrigger("wow-1", { source: "api", dedupKey: "twitch-ev-1" });
    expect(d.checkAndAdd(first)).toBe(true);
    expect(d.checkAndAdd(replay)).toBe(false);
  });

  it("generates unique ids", () => {
    const ids = new Set([generateTriggerId(), generateTriggerId(), generateTriggerId()]);
    expect(ids.size).toBe(3);
  });
});

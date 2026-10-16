import { describe, it, expect } from "vitest";
import { createPack } from "../packSchemas";
import {
  resolveEffectById,
  resolveMomentToEffect,
  resolveTemplateForEffect,
} from "../resolve";

function videoEffect(id: string, moment: "wow" | "funny" | "sad" = "wow") {
  return {
    id,
    name: id,
    kind: "video" as const,
    mediaFile: "clip.webm",
    moment,
    durationMs: 2700,
    delayMs: 0,
    cooldownMs: 0,
    priority: 80,
    queue: "queue" as const,
    enabled: true,
    volume: 1,
    position: "center" as const,
    entrance: "pop" as const,
    exit: "fade" as const,
    muted: false,
  };
}

describe("pack-aware resolution (M6)", () => {
  it("prefers pack effects and falls back to the static registry", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("custom-1"));
    expect(resolveEffectById("custom-1", pack)).toMatchObject({ id: "custom-1" });
    expect(resolveEffectById("effect-wow-1", pack)).toMatchObject({
      id: "effect-wow-1",
    });
    expect(() => resolveEffectById("nope", pack)).toThrow(/Unknown effect ID/);
    expect(() => resolveEffectById("nope", null)).toThrow(/Unknown effect ID/);
  });

  it("routes moment triggers through pack assignments first", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("custom-1", "funny"));
    pack.assignments.push({
      id: "a1",
      source: "ai-detector",
      moment: "funny",
      effectId: "custom-1",
    });
    const hit = resolveMomentToEffect("funny", "ai-detector", pack, () => 0);
    expect(hit && "id" in hit && hit.id).toBe("custom-1");
    // Other sources still use the V1 static pick.
    const fallback = resolveMomentToEffect("funny", "manual", pack, () => 0);
    expect(fallback && "id" in fallback && (fallback as { id: string }).id).toBe(
      "effect-funny-1"
    );
    // No pack at all: pure V1 behaviour.
    const plain = resolveMomentToEffect("wow", "ai-detector", null, () => 0.999);
    expect(plain && "id" in plain && (plain as { id: string }).id).toBe("effect-wow-2");
  });

  it("skips disabled pack effects back to the static pick", () => {
    const pack = createPack("p");
    pack.effects.push({ ...videoEffect("custom-1", "sad"), enabled: false });
    pack.assignments.push({
      id: "a1",
      source: "ai-detector",
      moment: "sad",
      effectId: "custom-1",
    });
    const result = resolveMomentToEffect("sad", "ai-detector", pack, () => 0);
    expect(result && "id" in result && (result as { id: string }).id).toBe(
      "effect-sad-1"
    );
  });

  it("finds template art only where it exists", () => {
    expect(
      resolveTemplateForEffect({ id: "x", name: "X", kind: "frame", templateId: "wow-1", moment: "wow", durationMs: 8000, delayMs: 0, cooldownMs: 0, priority: 50, queue: "replace", enabled: true, zIndex: 100, opacity: 1 })?.id
    ).toBe("wow-1");
    expect(resolveTemplateForEffect(videoEffect("v"))).toBeNull();
  });
});

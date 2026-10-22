import { describe, it, expect } from "vitest";
import { createPack } from "../packSchemas";
import {
  findAssignment,
  resolveEffectById,
  resolveMomentToEffect,
  resolveTemplateForEffect,
  resolveTemplateTrigger,
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

  it("matches assignments by source and moment only", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("custom-1", "wow"));
    pack.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "custom-1" });
    expect(findAssignment("wow", "manual", pack)?.id).toBe("custom-1");
    expect(findAssignment("wow", "ai-detector", pack)).toBeNull();
    expect(findAssignment("sad", "manual", pack)).toBeNull();
    expect(findAssignment("wow", "manual", null)).toBeNull();
  });

  it("routes template triggers to assigned frames or media", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("custom-1", "wow"));
    pack.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "custom-1" });
    const media = resolveTemplateTrigger("wow-1", "manual", pack);
    expect(media.kind).toBe("media");
    if (media.kind === "media") expect(media.effect.id).toBe("custom-1");

    const pack2 = createPack("p2");
    pack2.effects.push({
      id: "frame-1",
      name: "F",
      kind: "frame",
      templateId: "wow-2",
      moment: "wow",
      durationMs: 8000,
      delayMs: 0,
      cooldownMs: 0,
      priority: 50,
      queue: "replace",
      enabled: true,
      zIndex: 100,
      opacity: 1,
    });
    pack2.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "frame-1" });
    const frame = resolveTemplateTrigger("wow-1", "manual", pack2);
    expect(frame.kind).toBe("frame");
    if (frame.kind === "frame") expect(frame.template.id).toBe("wow-2");

    const plain = resolveTemplateTrigger("wow-1", "manual", null);
    expect(plain.kind).toBe("static");
    if (plain.kind === "static") expect(plain.template.id).toBe("wow-1");
  });

  it("treats assignments without a moment as source wildcards after exact matches", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("specific", "wow"));
    pack.effects.push(videoEffect("generic", "sad"));
    pack.assignments.push({ id: "a1", source: "timer", moment: "wow", effectId: "specific" });
    pack.assignments.push({ id: "a2", source: "timer", effectId: "generic" });
    // Exact moment wins when present.
    expect(findAssignment("wow", "timer", pack)?.id).toBe("specific");
    // Other moments fall through to the wildcard.
    expect(findAssignment("sad", "timer", pack)?.id).toBe("generic");
    expect(findAssignment("funny", "timer", pack)?.id).toBe("generic");
    // Other sources do not match the wildcard.
    expect(findAssignment("sad", "manual", pack)).toBeNull();
  });

  it("prefers exact moment rules over later wildcards in pack order", () => {
    const pack = createPack("p");
    pack.effects.push(videoEffect("wild", "wow"));
    pack.effects.push(videoEffect("exact", "wow"));
    pack.assignments.push({ id: "w", source: "hotkey", effectId: "wild" });
    pack.assignments.push({ id: "e", source: "hotkey", moment: "wow", effectId: "exact" });
    expect(findAssignment("wow", "hotkey", pack)?.id).toBe("exact");
  });
});

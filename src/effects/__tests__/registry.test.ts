import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  EFFECTS,
  getEffectById,
  getEffectsForMoment,
  pickRandomEffect,
} from "../registry";
import {
  resolveToLegacy,
  ExpiredTriggerError,
  useEditPipeline,
} from "../../hooks/useEditPipeline";
import {
  createMomentTrigger,
  createTemplateTrigger,
  createEffectTrigger,
} from "../../trigger/triggerSchemas";
import { createPack } from "../../packs/packSchemas";

const { mockCompose, mockCaptureFrame } = vi.hoisted(() => ({
  mockCompose: vi.fn(),
  mockCaptureFrame: vi.fn(),
}));

vi.mock("../../compose/EditComposer", () => ({
  compose: (...args: unknown[]) => mockCompose(...args),
  captureFrame: (...args: unknown[]) => mockCaptureFrame(...args),
}));

describe("effect registry + pipeline resolution (M2)", () => {
  it("exposes one effect per template", () => {
    expect(EFFECTS).toHaveLength(6);
    expect(getEffectsForMoment("wow")).toHaveLength(2);
    expect(getEffectsForMoment("funny")).toHaveLength(2);
    expect(getEffectsForMoment("sad")).toHaveLength(2);
  });

  it("looks up by effect id and rejects unknowns loudly", () => {
    expect(getEffectById("effect-wow-1").templateId).toBe("wow-1");
    expect(() => getEffectById("effect-nope")).toThrow(/Unknown effect ID/);
  });

  it("picks deterministically with an injected random source", () => {
    expect(pickRandomEffect("wow", () => 0)?.templateId).toBe("wow-1");
    expect(pickRandomEffect("wow", () => 0.999)?.templateId).toBe("wow-2");
  });

  it("resolves contract moment/template/effect triggers to the legacy shape", () => {
    expect(
      resolveToLegacy(createMomentTrigger("wow", { source: "ai-detector", confidence: 0.8, timestamp: 1000 }))
    ).toEqual({ source: "ai-detector", moment: "wow", confidence: 0.8, at: 1000 });

    expect(
      resolveToLegacy(createTemplateTrigger("sad-2", { source: "manual", timestamp: 2000 }))
    ).toEqual({ source: "manual", templateId: "sad-2", at: 2000 });

    expect(
      resolveToLegacy(createEffectTrigger("effect-funny-1", { source: "manual", timestamp: 3000 }))
    ).toEqual({ source: "manual", templateId: "funny-1", at: 3000 });
  });

  it("rejects expired triggers before they reach the composer", () => {
    const expired = createTemplateTrigger("wow-1", {
      source: "manual",
      timestamp: 1000,
      expiresAt: 1500,
    });
    vi.setSystemTime(2000);
    try {
      expect(() => resolveToLegacy(expired)).toThrow(ExpiredTriggerError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fireTrigger drops expired events without composing", () => {
    mockCaptureFrame.mockReturnValue({} as unknown as HTMLCanvasElement);
    mockCompose.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const { result } = renderHook(() => useEditPipeline());
    const expired = createTemplateTrigger("wow-1", {
      source: "manual",
      timestamp: 1000,
      expiresAt: 1500,
    });
    vi.setSystemTime(2000);
    try {
      act(() => {
        result.current.fireTrigger({} as HTMLVideoElement, expired);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("fireTrigger still accepts legacy events (backwards compat)", () => {
    mockCaptureFrame.mockReturnValue({} as unknown as HTMLCanvasElement);
    mockCompose.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const { result } = renderHook(() => useEditPipeline());
    act(() => {
      result.current.fireTrigger({} as HTMLVideoElement, {
        source: "manual",
        templateId: "wow-1",
        at: Date.now(),
      });
    });
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it("routes pack assignments to the assigned frame, not a random one", () => {
    const pack = createPack("p");
    pack.effects.push({
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
    pack.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "frame-1" });
    pack.assignments.push({ id: "a2", source: "ai-detector", moment: "wow", effectId: "frame-1" });
    // Manual button for wow-1 resolves to the assigned wow-2 template.
    expect(
      resolveToLegacy({ source: "manual", templateId: "wow-1", at: 1000 }, pack)
    ).toEqual({ source: "manual", templateId: "wow-2", at: 1000 });
    // Detector moments resolve through the same rule with their own source.
    expect(
      resolveToLegacy(
        createMomentTrigger("wow", { source: "ai-detector", timestamp: 1000 }),
        pack
      )
    ).toEqual({ source: "manual", templateId: "wow-2", at: 1000 });
    // A detector trigger does NOT match a manual-only assignment.
    const manualOnly = createPack("m");
    manualOnly.effects.push({
      id: "frame-9",
      name: "F9",
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
    manualOnly.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "frame-9" });
    expect(
      resolveToLegacy(
        createMomentTrigger("wow", { source: "ai-detector", timestamp: 1000 }),
        manualOnly
      )
    ).toEqual({
      source: "ai-detector",
      moment: "wow",
      confidence: 0,
      at: 1000,
    });
    // Without a pack the requested template plays unchanged (V1).
    expect(
      resolveToLegacy({ source: "manual", templateId: "wow-1", at: 1000 }, undefined)
    ).toEqual({ source: "manual", templateId: "wow-1", at: 1000 });
  });

  it("leaves pack media effects for the OBS relay (never faked as PNGs)", () => {
    mockCaptureFrame.mockReturnValue({} as unknown as HTMLCanvasElement);
    mockCompose.mockClear();
    mockCompose.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const pack = createPack("p");
    pack.effects.push({
      id: "clip-1",
      name: "Clip",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 2700,
      delayMs: 0,
      cooldownMs: 0,
      priority: 50,
      queue: "replace",
      enabled: true,
      volume: 1,
      position: "center",
      entrance: "pop",
      exit: "fade",
      muted: false,
    });
    pack.assignments.push({ id: "a1", source: "manual", moment: "wow", effectId: "clip-1" });
    const { result } = renderHook(() => useEditPipeline());
    act(() => {
      result.current.fireTrigger(
        {} as HTMLVideoElement,
        { source: "manual", templateId: "wow-1", at: Date.now() },
        pack
      );
    });
    expect(mockCompose).not.toHaveBeenCalled();
    expect(() =>
      resolveToLegacy(createEffectTrigger("clip-1", { source: "manual" }), pack)
    ).toThrow(/media-only/);
  });
});

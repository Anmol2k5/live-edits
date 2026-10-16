import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishOverlayTrigger } from "../overlayClient";
import {
  createMomentTrigger,
  createTemplateTrigger,
  createEffectTrigger,
} from "../../trigger/triggerSchemas";

describe("overlayClient payload (M3)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ connectedOverlays: 1 }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("forwards contract fields for moment triggers", async () => {
    const calls = mockFetch();
    const event = createMomentTrigger("wow", {
      source: "ai-detector",
      confidence: 0.9,
      id: "trigger-1",
      dedupKey: "dedup-1",
      expiresAt: Date.now() + 5000,
    });
    await publishOverlayTrigger(event, "token", "");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      moment: "wow",
      templateId: "wow-1",
      triggerId: "trigger-1",
      dedupKey: "dedup-1",
      queue: "replace",
    });
    expect(typeof calls[0].body.expiresAt).toBe("number");
  });

  it("resolves effect triggers with their queue policy", async () => {
    const calls = mockFetch();
    const event = createEffectTrigger("effect-funny-2", { source: "manual", id: "trigger-2" });
    await publishOverlayTrigger(event, "token", "clip.webm");
    expect(calls[0].body).toMatchObject({
      moment: "funny",
      templateId: "funny-2",
      effectId: "effect-funny-2",
      mediaFile: "clip.webm",
      triggerId: "trigger-2",
    });
  });

  it("keeps legacy triggers working and forwards media options", async () => {
    const calls = mockFetch();
    await publishOverlayTrigger(
      { source: "manual", templateId: "sad-1", at: 1234 },
      "token",
      { mediaFile: "sting.mp3", volume: 0.4, durationMs: 3000 }
    );
    expect(calls[0].body).toMatchObject({
      moment: "sad",
      templateId: "sad-1",
      mediaFile: "sting.mp3",
      volume: 0.4,
      durationMs: 3000,
    });
  });

  it("publishes without any camera or video element involved", async () => {
    const calls = mockFetch();
    const event = createTemplateTrigger("wow-2", { source: "manual" });
    // No document/camera access here by construction — the call takes only
    // the validated event, a token and a filename.
    await publishOverlayTrigger(event, "token", "");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.templateId).toBe("wow-2");
  });

  it("requires a publish token", async () => {
    await expect(
      publishOverlayTrigger(
        { source: "manual", templateId: "wow-1", at: Date.now() },
        "",
        ""
      )
    ).rejects.toThrow(/publish token/i);
  });

  it("publishes pack media effects with their full playback config", async () => {
    const calls = mockFetch();
    const { createPack } = await import("../../packs/packSchemas");
    const pack = createPack("Stream Pack");
    pack.effects.push({
      id: "custom-clip",
      name: "Clip",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 3200,
      delayMs: 0,
      cooldownMs: 1000,
      priority: 70,
      queue: "queue",
      enabled: true,
      volume: 0.4,
      position: "fullscreen",
      entrance: "fade",
      exit: "fade",
      muted: false,
      clipStartMs: 200,
      clipEndMs: 2200,
    });
    const event = createEffectTrigger("custom-clip", { source: "manual" });
    await publishOverlayTrigger(event, "token", "", pack);
    expect(calls[0].body).toMatchObject({
      effectId: "custom-clip",
      moment: "wow",
      templateId: "wow-1",
      mediaFile: "clip.webm",
      durationMs: 3200,
      volume: 0.4,
      position: "fullscreen",
      queue: "queue",
      priority: 70,
      cooldownMs: 1000,
      clipStartMs: 200,
      clipEndMs: 2200,
    });
  });

  it("lets caller media options override pack effect defaults", async () => {
    const calls = mockFetch();
    const { createPack } = await import("../../packs/packSchemas");
    const pack = createPack("Stream Pack");
    pack.effects.push({
      id: "custom-clip",
      name: "Clip",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 3200,
      delayMs: 0,
      cooldownMs: 0,
      priority: 50,
      queue: "replace",
      enabled: true,
      volume: 0.4,
      position: "center",
      entrance: "pop",
      exit: "fade",
      muted: false,
    });
    const event = createEffectTrigger("custom-clip", { source: "manual" });
    await publishOverlayTrigger(event, "token", { volume: 0.9 }, pack);
    expect(calls[0].body).toMatchObject({ volume: 0.9, durationMs: 3200 });
  });

  it("rejects unknown effect ids instead of publishing blindly", async () => {
    mockFetch();
    const event = createEffectTrigger("effect-ghost", { source: "manual" });
    await expect(publishOverlayTrigger(event, "token", "")).rejects.toThrow(
      /Unknown effect ID/
    );
  });
});

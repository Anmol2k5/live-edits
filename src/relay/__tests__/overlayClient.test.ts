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
});

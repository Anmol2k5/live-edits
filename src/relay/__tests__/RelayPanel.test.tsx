import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { RelayPanel } from "../RelayPanel";

describe("RelayPanel (M4/M5 setup workflow)", () => {
  const props = {
    relayBase: "http://127.0.0.1:4190",
    setRelayBase: vi.fn(),
    relayToken: "",
    setRelayToken: vi.fn(),
    mediaFile: "",
    setMediaFile: vi.fn(),
    volume: "1",
    setVolume: vi.fn(),
    durationMs: "",
    setDurationMs: vi.fn(),
    relayStatus: "Not connected",
    cameraActive: false,
    onTestReaction: vi.fn(),
  };

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unreachable");
      })
    );
  });

  it("announces webcam-free manual mode without a camera", () => {
    render(<RelayPanel {...props} />);
    expect(screen.getByText(/webcam-free manual mode/i)).toBeTruthy();
  });

  it("announces expression mode when the camera is active", () => {
    render(<RelayPanel {...props} cameraActive />);
    expect(screen.getByText(/expression mode/i)).toBeTruthy();
  });

  it("disables the test reaction without a token", () => {
    render(<RelayPanel {...props} />);
    expect(screen.getByText("Send test reaction").closest("button")?.disabled).toBe(true);
  });

  it("asks for the token before copying an OBS url", async () => {
    render(<RelayPanel {...props} />);
    fireEvent.click(screen.getByText("Copy OBS URL"));
    await waitFor(() => {
      expect(screen.getByText(/paste the publish token first/i)).toBeTruthy();
    });
    expect(props.onTestReaction).not.toHaveBeenCalled();
  });

  it("lists relay media and flags a missing selection", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/health")) {
        return { ok: false, status: 0, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          media: [{ name: "clip.webm", bytes: 2048, kind: "video" }],
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RelayPanel {...props} relayToken="token" mediaFile="missing.mp3" />);
    fireEvent.click(screen.getByText("Check relay media"));
    await waitFor(() => {
      expect(screen.getByText(/clip\.webm/)).toBeTruthy();
    });
    expect(screen.getByText(/NOT on the relay/i)).toBeTruthy();
  });

  it("fires the test reaction callback when configured", () => {
    const onTestReaction = vi.fn();
    render(<RelayPanel {...props} relayToken="token" onTestReaction={onTestReaction} />);
    expect(screen.getByText("Send test reaction").closest("button")?.disabled).toBe(false);
    fireEvent.click(screen.getByText("Send test reaction"));
    expect(onTestReaction).toHaveBeenCalledTimes(1);
  });
});

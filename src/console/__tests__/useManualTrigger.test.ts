import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useManualTrigger } from "../useManualTrigger";

describe("useManualTrigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first press returns a TriggerEvent", () => {
    const { result } = renderHook(() => useManualTrigger());

    let event: ReturnType<typeof result.current.fire>;
    act(() => {
      event = result.current.fire("wow-1");
    });

    expect(event!).not.toBeNull();
    expect(event!).toMatchObject({
      source: "manual",
      templateId: "wow-1",
    });
  });

  it("second press within 500ms returns null (debounced)", () => {
    const { result } = renderHook(() => useManualTrigger());

    let first: ReturnType<typeof result.current.fire>;
    let second: ReturnType<typeof result.current.fire>;

    act(() => {
      first = result.current.fire("wow-1");
    });
    expect(first!).not.toBeNull();

    // Advance only 200ms — still inside debounce window
    vi.advanceTimersByTime(200);
    vi.setSystemTime(1200);

    act(() => {
      second = result.current.fire("wow-1");
    });
    expect(second!).toBeNull();
  });

  it("press after 500ms returns a new TriggerEvent", () => {
    const { result } = renderHook(() => useManualTrigger());

    act(() => {
      result.current.fire("wow-1");
    });

    // Advance past debounce window
    vi.advanceTimersByTime(500);
    vi.setSystemTime(1500);

    let event: ReturnType<typeof result.current.fire>;
    act(() => {
      event = result.current.fire("sad-1");
    });

    expect(event!).not.toBeNull();
    expect(event!).toMatchObject({
      source: "manual",
      templateId: "sad-1",
    });
  });

  it("debounce applies across different template IDs", () => {
    const { result } = renderHook(() => useManualTrigger());

    act(() => {
      result.current.fire("wow-1");
    });

    vi.advanceTimersByTime(100);
    vi.setSystemTime(1100);

    let event: ReturnType<typeof result.current.fire>;
    act(() => {
      event = result.current.fire("funny-2");
    });
    expect(event!).toBeNull();
  });

  it("throws on an unknown template ID", () => {
    const { result } = renderHook(() => useManualTrigger());

    expect(() => {
      act(() => {
        result.current.fire("nonexistent-template");
      });
    }).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, StrictMode, type PropsWithChildren } from "react";
import { useUndoable, isDirty } from "../useUndoable";

describe("undo/redo + dirty tracking (M6)", () => {
  it("keeps history correct when StrictMode replays state updates", () => {
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(StrictMode, null, children);
    const { result } = renderHook(() => useUndoable(0), { wrapper });
    act(() => result.current.set(1));
    act(() => result.current.set(2));
    act(() => result.current.undo());
    expect(result.current.state).toBe(1);
    act(() => result.current.undo());
    expect(result.current.state).toBe(0);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.state).toBe(1);
    act(() => result.current.redo());
    expect(result.current.state).toBe(2);
    expect(result.current.canRedo).toBe(false);
  });

  it("pushes, undoes and redoes object states", () => {
    const { result } = renderHook(() => useUndoable({ n: 0 }));
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.set({ n: 1 });
    });
    act(() => {
      result.current.set({ n: 2 });
    });
    expect(result.current.state).toEqual({ n: 2 });
    act(() => {
      result.current.undo();
    });
    expect(result.current.state).toEqual({ n: 1 });
    expect(result.current.canRedo).toBe(true);
    act(() => {
      result.current.redo();
    });
    expect(result.current.state).toEqual({ n: 2 });
  });

  it("coalesces identical states and clears redo on new edits", () => {
    const { result } = renderHook(() => useUndoable("a"));
    act(() => {
      result.current.set("a");
    });
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.set("b");
    });
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.set("c");
    });
    expect(result.current.canRedo).toBe(false);
    expect(result.current.state).toBe("c");
  });

  it("bounds history and resets cleanly", () => {
    const { result } = renderHook(() => useUndoable(0, 3));
    for (let i = 1; i <= 5; i += 1) {
      act(() => {
        result.current.set(i);
      });
    }
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.state).toBe(2);
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.reset(99);
    });
    expect(result.current.state).toBe(99);
    expect(result.current.canUndo).toBe(false);
  });

  it("flags unsaved changes by deep comparison", () => {
    expect(isDirty({ a: [1] }, { a: [1] })).toBe(false);
    expect(isDirty({ a: [2] }, { a: [1] })).toBe(true);
  });
});

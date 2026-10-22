import { useCallback, useMemo, useRef, useState } from "react";

const DEFAULT_LIMIT = 50;

export interface Undoable<T> {
  state: T;
  set: (next: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: (next: T) => void;
}

/**
 * Bounded undo/redo over immutable snapshots. Identical consecutive states
 * (by JSON) are coalesced so typing a name doesn't flood the stack.
 */
export function useUndoable<T>(initial: T, limit: number = DEFAULT_LIMIT): Undoable<T> {
  const [history, setHistory] = useState({
    past: [] as T[],
    present: initial,
    future: [] as T[],
  });
  const { past, present, future } = history;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setHistory((prev) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(prev.present) : next;
      if (JSON.stringify(value) === JSON.stringify(prev.present)) return prev;
      const grown = [...prev.past, prev.present];
      return {
        past: grown.length > limitRef.current
          ? grown.slice(grown.length - limitRef.current)
          : grown,
        present: value,
        future: [],
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      return {
        past: prev.past.slice(0, -1),
        present: prev.past[prev.past.length - 1] as T,
        future: [prev.present, ...prev.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [next, ...rest] = prev.future as [T, ...T[]];
      const grown = [...prev.past, prev.present];
      return {
        past: grown.length > limitRef.current
          ? grown.slice(grown.length - limitRef.current)
          : grown,
        present: next,
        future: rest,
      };
    });
  }, []);

  const reset = useCallback((next: T) => {
    setHistory({ past: [], present: next, future: [] });
  }, []);

  return useMemo(
    () => ({
      state: present,
      set,
      undo,
      redo,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      reset,
    }),
    [present, past.length, future.length, set, undo, redo, reset]
  );
}

/** Unsaved-changes signal: deep comparison against the last saved snapshot. */
export function isDirty<T>(draft: T, saved: T): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

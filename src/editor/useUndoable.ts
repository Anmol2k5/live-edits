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
  const [past, setPast] = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initial);
  const [future, setFuture] = useState<T[]>([]);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setPresent((prev) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (JSON.stringify(value) === JSON.stringify(prev)) return prev;
      setPast((p) => {
        const grown = [...p, prev];
        return grown.length > limitRef.current
          ? grown.slice(grown.length - limitRef.current)
          : grown;
      });
      setFuture([]);
      return value;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1] as T;
      const rest = p.slice(0, -1);
      setPresent((cur) => {
        setFuture((f) => [cur, ...f]);
        return previous;
      });
      return rest;
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const [next, ...rest] = f as [T, ...T[]];
      setPresent((cur) => {
        setPast((p) => {
          const grown = [...p, cur];
          return grown.length > limitRef.current
            ? grown.slice(grown.length - limitRef.current)
            : grown;
        });
        return next;
      });
      return rest;
    });
  }, []);

  const reset = useCallback((next: T) => {
    setPast([]);
    setFuture([]);
    setPresent(next);
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

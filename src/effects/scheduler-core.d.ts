/**
 * Types for the dependency-free `./scheduler-core.js` shared implementation.
 * Behaviour is pinned by `shared/scheduler-cases.json` conformance tests.
 */

export type CoreQueuePolicy =
  | "queue"
  | "interrupt"
  | "replace"
  | "ignore"
  | "coexist";

export interface CoreEffect {
  id: string;
  enabled: boolean;
  priority: number;
  queue: CoreQueuePolicy;
  cooldownMs: number;
}

export interface CoreTrigger {
  id: string;
  dedupKey?: string;
  expiresAt?: number;
}

export type CoreAction = "start" | "enqueue" | "replace" | "drop";

export type CoreReason =
  | "ok"
  | "disabled"
  | "expired"
  | "duplicate"
  | "cooldown"
  | "queue-full"
  | "ignored-while-busy";

export interface CoreItem {
  key: string;
  effectId: string;
  priority: number;
  queue: CoreQueuePolicy;
  triggerId: string;
  enqueuedAt: number;
}

export interface CoreResult {
  action: CoreAction;
  reason: CoreReason;
  key?: string;
  preempted?: CoreItem;
}

export interface CoreSchedulerOptions {
  maxQueue?: number;
  dedupSize?: number;
}

export interface CoreScheduler {
  submit: (effect: CoreEffect, trigger: CoreTrigger, now?: number) => CoreResult;
  finish: (key?: string) => CoreItem | null;
  clear: () => void;
  /** Drop waiting items without touching the playing item (interrupts). */
  clearWaiting: () => void;
  reset: () => void;
  playing: () => CoreItem | null;
  queued: () => CoreItem[];
  queueLength: () => number;
}

declare global {
  // Set by the `./scheduler-core.js` side-effect import.
  var LiveEditsScheduler:
    | { createScheduler: (options?: CoreSchedulerOptions) => CoreScheduler }
    | undefined;
}

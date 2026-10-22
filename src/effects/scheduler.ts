import "./scheduler-core.js";
import type {
  CoreEffect,
  CoreQueuePolicy,
  CoreScheduler,
  CoreSchedulerOptions,
} from "./scheduler-core.js";
import type { AnyEffect, QueuePolicy } from "./effectSchemas";

/**
 * Typed desktop wrapper around the dependency-free shared core
 * (`./scheduler-core.js`). All decisions live in the core so the OBS
 * overlay player (loaded over HTTP) and both test harnesses share one
 * implementation; behaviour is pinned by `shared/scheduler-cases.json`.
 */

export interface SchedulableTrigger {
  id: string;
  dedupKey?: string;
  expiresAt?: number;
  timestamp?: number;
}

export interface ScheduledItem {
  key: string;
  effectId: string;
  priority: number;
  queue: QueuePolicy;
  triggerId: string;
  enqueuedAt: number;
}

export type SubmitAction = "start" | "enqueue" | "replace" | "drop";

export interface SubmitResult {
  action: SubmitAction;
  reason:
    | "ok"
    | "disabled"
    | "expired"
    | "duplicate"
    | "cooldown"
    | "queue-full"
    | "ignored-while-busy";
  /** Scheduling key for start/enqueue/replace outcomes. */
  key?: string;
  /** The item that was playing when a replace/interrupt landed. */
  preempted?: ScheduledItem;
}

export interface SchedulerOptions extends CoreSchedulerOptions {
  /** Max waiting items (playing item excluded). Overlay uses 6. */
  maxQueue?: number;
  /** Bound for the dedup cache. */
  dedupSize?: number;
}

function toCoreEffect(
  effect: Pick<AnyEffect, "id" | "enabled" | "priority" | "queue" | "cooldownMs">
): CoreEffect {
  return {
    id: effect.id,
    enabled: effect.enabled,
    priority: effect.priority,
    queue: effect.queue as CoreQueuePolicy,
    cooldownMs: effect.cooldownMs,
  };
}

function toItem(raw: {
  key: string;
  effectId: string;
  priority: number;
  queue: CoreQueuePolicy;
  triggerId: string;
  enqueuedAt: number;
}): ScheduledItem {
  return {
    key: raw.key,
    effectId: raw.effectId,
    priority: raw.priority,
    queue: raw.queue as QueuePolicy,
    triggerId: raw.triggerId,
    enqueuedAt: raw.enqueuedAt,
  };
}

export class EffectScheduler {
  private readonly core: CoreScheduler;

  constructor(options: SchedulerOptions = {}) {
    const factory = globalThis.LiveEditsScheduler?.createScheduler;
    if (!factory) {
      throw new Error("Shared scheduler core failed to initialise.");
    }
    this.core = factory(options);
  }

  get playing(): ScheduledItem | null {
    const current = this.core.playing();
    return current ? toItem(current) : null;
  }

  get queued(): readonly ScheduledItem[] {
    return this.core.queued().map(toItem);
  }

  get queueLength(): number {
    return this.core.queueLength();
  }

  submit(
    effect: Pick<AnyEffect, "id" | "enabled" | "priority" | "queue" | "cooldownMs">,
    trigger: SchedulableTrigger,
    now: number = Date.now()
  ): SubmitResult {
    const result = this.core.submit(toCoreEffect(effect), trigger, now);
    return {
      action: result.action,
      reason: result.reason,
      ...(result.key !== undefined ? { key: result.key } : {}),
      ...(result.preempted ? { preempted: toItem(result.preempted) } : {}),
    };
  }

  /**
   * Mark the playing item finished; promotes the highest-priority waiter.
   * Returns the item to start next, if any.
   */
  finish(key?: string): ScheduledItem | null {
    const next = this.core.finish(key);
    return next ? toItem(next) : null;
  }

  clear(): void {
    this.core.clear();
  }

  /** Drop waiting items without touching the playing item (interrupts). */
  clearWaiting(): void {
    this.core.clearWaiting();
  }

  /** Clear playback state, dedup memory and cooldowns (relay restarts). */
  reset(): void {
    this.core.reset();
  }
}

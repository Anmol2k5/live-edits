import { TriggerDeduper } from "../trigger/triggerSchemas";
import type { AnyEffect, QueuePolicy } from "./effectSchemas";

/**
 * M3 reusable playback scheduler core (DOM-free).
 *
 * Decides what happens when a validated trigger resolves to an effect
 * while something is already playing. The OBS overlay mirrors this policy
 * in its inline player; unit tests exercise this module directly with
 * fake timers so queue/priority/expiry/dedup behaviour is deterministic.
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
  /** The item that was playing when a replace/interrupt landed. */
  preempted?: ScheduledItem;
}

export interface SchedulerOptions {
  /** Max waiting items (playing item excluded). Overlay uses 6. */
  maxQueue?: number;
  /** Bound for the dedup cache. */
  dedupSize?: number;
}

const DEFAULT_MAX_QUEUE = 6;

let schedulerCounter = 0;

export class EffectScheduler {
  private current: ScheduledItem | null = null;
  private readonly waiting: ScheduledItem[] = [];
  private readonly deduper: TriggerDeduper;
  private readonly lastFiredAt = new Map<string, number>();
  private readonly maxQueue: number;

  constructor(options: SchedulerOptions = {}) {
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.deduper = new TriggerDeduper(options.dedupSize ?? 500);
  }

  get playing(): ScheduledItem | null {
    return this.current;
  }

  get queued(): readonly ScheduledItem[] {
    return this.waiting;
  }

  get queueLength(): number {
    return this.waiting.length;
  }

  submit(
    effect: Pick<
      AnyEffect,
      "id" | "enabled" | "priority" | "queue" | "cooldownMs"
    >,
    trigger: SchedulableTrigger,
    now: number = Date.now()
  ): SubmitResult {
    if (!effect.enabled) {
      return { action: "drop", reason: "disabled" };
    }
    if (trigger.expiresAt !== undefined && now > trigger.expiresAt) {
      return { action: "drop", reason: "expired" };
    }
    if (!this.deduper.checkAndAdd(trigger)) {
      return { action: "drop", reason: "duplicate" };
    }
    const last = this.lastFiredAt.get(effect.id);
    if (last !== undefined && now - last < effect.cooldownMs) {
      return { action: "drop", reason: "cooldown" };
    }

    const item: ScheduledItem = {
      key: `${effect.id}#${trigger.id}#${(schedulerCounter += 1)}`,
      effectId: effect.id,
      priority: effect.priority,
      queue: effect.queue,
      triggerId: trigger.id,
      enqueuedAt: now,
    };

    if (this.current === null) {
      this.current = item;
      this.lastFiredAt.set(effect.id, now);
      return { action: "start", reason: "ok" };
    }

    switch (effect.queue) {
      case "ignore":
        return { action: "drop", reason: "ignored-while-busy" };
      case "replace":
      case "interrupt": {
        const preempted = this.current;
        this.current = item;
        this.lastFiredAt.set(effect.id, now);
        return { action: "replace", reason: "ok", preempted };
      }
      case "coexist":
        // Single-slot stage: coexist starts immediately and shares the
        // slot lifetime; the caller layers it. Track as current so the
        // next submit still sees a busy stage.
        this.lastFiredAt.set(effect.id, now);
        return { action: "start", reason: "ok" };
      case "queue": {
        if (this.waiting.length >= this.maxQueue) {
          return { action: "drop", reason: "queue-full" };
        }
        // Priority-ordered insert, stable for equal priority.
        let index = this.waiting.length;
        for (let i = 0; i < this.waiting.length; i += 1) {
          if (this.waiting[i].priority < item.priority) {
            index = i;
            break;
          }
        }
        this.waiting.splice(index, 0, item);
        this.lastFiredAt.set(effect.id, now);
        return { action: "enqueue", reason: "ok" };
      }
    }
  }

  /**
   * Mark the playing item finished; promotes the highest-priority waiter.
   * Returns the item to start next, if any.
   */
  finish(key?: string): ScheduledItem | null {
    if (key !== undefined && this.current?.key !== key) {
      const queuedIndex = this.waiting.findIndex((w) => w.key === key);
      if (queuedIndex >= 0) this.waiting.splice(queuedIndex, 1);
      return null;
    }
    this.current = this.waiting.shift() ?? null;
    return this.current;
  }

  clear(): void {
    this.current = null;
    this.waiting.length = 0;
  }
}

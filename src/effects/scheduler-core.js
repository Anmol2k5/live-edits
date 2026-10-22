/**
 * Shared effect-scheduling core (dependency-free).
 *
 * Single implementation used by:
 * - `src/effects/scheduler.ts` (typed TS wrapper for the desktop app/tests)
 * - `public/obs-overlay.html` via the relay's `/obs-player.js` route
 * - `node:test` conformance harness importing this file directly
 *
 * Keep this file free of imports/exports syntax so it runs unchanged as a
 * classic browser script, a node ESM side-effect import, and a Vite module.
 * Behavioural changes must update `shared/scheduler-cases.json` expectations.
 */
(function (root) {
  "use strict";

  var DEFAULT_MAX_QUEUE = 6;
  var DEFAULT_DEDUP_SIZE = 500;
  var keyCounter = 0;

  function checkAndAdd(seen, maxSize, trigger) {
    var key = trigger.dedupKey !== undefined && trigger.dedupKey !== null
      ? trigger.dedupKey
      : trigger.id;
    if (seen.has(key)) return false;
    seen.set(key, Date.now());
    if (seen.size > maxSize) {
      var oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  function createScheduler(options) {
    var opts = options || {};
    var maxQueue = opts.maxQueue !== undefined ? opts.maxQueue : DEFAULT_MAX_QUEUE;
    var dedupSize = opts.dedupSize !== undefined ? opts.dedupSize : DEFAULT_DEDUP_SIZE;
    var seen = new Map();
    var lastFiredAt = new Map();
    var current = null;
    var waiting = [];

    function submit(effect, trigger, now) {
      var at = now !== undefined ? now : Date.now();
      if (!effect || effect.enabled === false) {
        return { action: "drop", reason: "disabled" };
      }
      if (trigger.expiresAt !== undefined && trigger.expiresAt !== null && at > trigger.expiresAt) {
        return { action: "drop", reason: "expired" };
      }
      if (!checkAndAdd(seen, dedupSize, trigger)) {
        return { action: "drop", reason: "duplicate" };
      }
      var last = lastFiredAt.get(effect.id);
      if (last !== undefined && at - last < effect.cooldownMs) {
        return { action: "drop", reason: "cooldown" };
      }

      keyCounter += 1;
      var item = {
        key: effect.id + "#" + trigger.id + "#" + keyCounter,
        effectId: effect.id,
        priority: effect.priority,
        queue: effect.queue,
        triggerId: trigger.id,
        enqueuedAt: at,
      };

      if (current === null) {
        current = item;
        lastFiredAt.set(effect.id, at);
        return { action: "start", reason: "ok", key: item.key };
      }

      if (effect.queue === "ignore") {
        return { action: "drop", reason: "ignored-while-busy" };
      }
      if (effect.queue === "replace" || effect.queue === "interrupt") {
        var preempted = current;
        current = item;
        lastFiredAt.set(effect.id, at);
        return { action: "replace", reason: "ok", key: item.key, preempted: preempted };
      }
      if (effect.queue === "coexist") {
        lastFiredAt.set(effect.id, at);
        return { action: "start", reason: "ok", key: item.key };
      }
      // "queue": priority-ordered insert, stable for equal priority.
      if (waiting.length >= maxQueue) {
        return { action: "drop", reason: "queue-full" };
      }
      var index = waiting.length;
      for (var i = 0; i < waiting.length; i += 1) {
        if (waiting[i].priority < item.priority) {
          index = i;
          break;
        }
      }
      waiting.splice(index, 0, item);
      lastFiredAt.set(effect.id, at);
      return { action: "enqueue", reason: "ok", key: item.key };
    }

    function finish(key) {
      if (key !== undefined && (current === null || current.key !== key)) {
        for (var i = 0; i < waiting.length; i += 1) {
          if (waiting[i].key === key) {
            waiting.splice(i, 1);
            break;
          }
        }
        return null;
      }
      current = waiting.length > 0 ? waiting.shift() : null;
      return current;
    }

    function clear() {
      current = null;
      waiting.length = 0;
    }

    function clearWaiting() {
      waiting.length = 0;
    }

    function reset() {
      clear();
      seen.clear();
      lastFiredAt.clear();
    }

    return {
      submit: submit,
      finish: finish,
      clear: clear,
      clearWaiting: clearWaiting,
      reset: reset,
      playing: function () { return current; },
      queued: function () { return waiting.slice(); },
      queueLength: function () { return waiting.length; },
    };
  }

  root.LiveEditsScheduler = { createScheduler: createScheduler };
})(typeof globalThis !== "undefined" ? globalThis : this);

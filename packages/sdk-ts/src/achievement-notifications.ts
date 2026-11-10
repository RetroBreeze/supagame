import type { Achievement } from "@supagame/contracts";
import type { Achievements } from "./achievements.js";
export interface AchievementQueue {
  readonly current: Achievement | null;
  readonly pending: number;
  dismiss(): void;
  pause(): void;
  resume(): void;
  subscribe(listener: (current: Achievement | null) => void): () => void;
  dispose(): void;
}
/** Bounded FIFO. Overflow drops newest notifications; unlock persistence is unaffected. */
export function createAchievementQueue(
  source: Pick<Achievements, "onUnlocked">,
  options: { durationMs?: number; limit?: number; paused?: boolean } = {},
): AchievementQueue {
  const duration = options.durationMs ?? 4000, limit = options.limit ?? 50;
  if (
    !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(limit) ||
    limit < 1 || limit > 1000
  ) throw new Error("Invalid achievement queue options.");
  const queue: Achievement[] = [],
    seen = new Set<string>(),
    listeners = new Set<(a: Achievement | null) => void>();
  let current: Achievement | null = null,
    paused = options.paused ?? false,
    disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => {
    for (const cb of listeners) {
      try {
        cb(current);
      } catch { /* A renderer cannot block the queue. */ }
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!paused && current && !disposed) {
      timer = setTimeout(() => api.dismiss(), duration);
    }
  };
  const advance = () => {
    if (!current && !paused && !disposed) {
      current = queue.shift() ?? null;
      emit();
      schedule();
    }
  };
  const subscription = source.onUnlocked((a) => {
    if (disposed || !a.unlocked || a.historical || seen.has(a.id)) return;
    seen.add(a.id);
    if (queue.length + Number(!!current) < limit) queue.push(a);
    advance();
  });
  const api: AchievementQueue = {
    get current() {
      return current;
    },
    get pending() {
      return queue.length;
    },
    dismiss() {
      if (disposed) return;
      clearTimeout(timer);
      current = null;
      emit();
      advance();
    },
    pause() {
      paused = true;
      clearTimeout(timer);
    },
    resume() {
      paused = false;
      if (current) schedule();
      else advance();
    },
    subscribe(cb) {
      if (disposed) return () => {};
      listeners.add(cb);
      cb(current);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      disposed = true;
      subscription.unsubscribe();
      clearTimeout(timer);
      current = null;
      queue.length = 0;
      seen.clear();
      emit();
      listeners.clear();
    },
  };
  return api;
}

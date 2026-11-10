import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Achievement,
  createAchievementQueue,
  createGameServices,
} from "../../packages/sdk-ts/src/index.ts";
import { fixture } from "./fixtures.ts";
const locked: Achievement = {
  id: "coins",
  title: "Coins",
  description: "Collect coins",
  icon: "coin",
  category: null,
  metadata: {},
  progress: { current: 0, threshold: 500 },
  unlocked: false,
  unlockedAt: null,
  historical: false,
};
const earned = {
  ...locked,
  unlocked: true,
  unlockedAt: "2026-11-10T12:00:00Z",
};
afterEach(() => vi.useRealTimers());
describe("achievements", () => {
  it("hydrates silently, emits once, suppresses historical rows, and unsubscribes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let rows = [locked];
    f.fetcher.mockImplementation(async () => Response.json(rows));
    const api = createGameServices({ supabase: f.supabase }).achievements,
      cb = vi.fn();
    const subscription = api.onUnlocked(cb, { intervalMs: 250 });
    await subscription.ready;
    expect(cb).not.toHaveBeenCalled();
    rows = [earned, { ...earned, id: "old", historical: true }];
    await vi.advanceTimersByTimeAsync(250);
    expect(cb).toHaveBeenCalledExactlyOnceWith(earned);
    await api.getPlayerAchievements();
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    rows = [{ ...earned, id: "new" }];
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    api.dispose();
  });
  it("does not announce existing unlocks after a new subscription", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => Response.json([earned]));
    const api = createGameServices({ supabase: f.supabase }).achievements,
      cb = vi.fn();
    const s = api.onUnlocked(cb);
    await s.ready;
    expect(cb).not.toHaveBeenCalled();
    api.dispose();
  });
  it("queues FIFO with deduplication, bounded overflow, pause and cleanup", async () => {
    vi.useFakeTimers();
    let emit!: (a: Achievement) => void;
    const stop = vi.fn();
    const queue = createAchievementQueue({
      onUnlocked(cb) {
        emit = cb;
        return { ready: Promise.resolve(), unsubscribe: stop };
      },
    }, { durationMs: 100, limit: 2, paused: true });
    emit(earned);
    emit(earned);
    emit({ ...earned, id: "two" });
    emit({ ...earned, id: "overflow" });
    expect(queue.current).toBeNull();
    expect(queue.pending).toBe(2);
    queue.resume();
    expect(queue.current?.id).toBe("coins");
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.current?.id).toBe("two");
    queue.dismiss();
    expect(queue.current).toBeNull();
    queue.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

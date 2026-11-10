import type { Achievement } from "@supagame/contracts";
import { requireSession, type SupabaseConnection } from "./auth.js";
import type { Transport } from "./client.js";
export interface AchievementSubscription {
  ready: Promise<void>;
  unsubscribe(): void;
}
export interface Achievements {
  listAchievements(): Promise<Achievement[]>;
  getPlayerAchievements(): Promise<Achievement[]>;
  getAchievement(id: string): Promise<Achievement | null>;
  onUnlocked(
    callback: (achievement: Achievement) => void,
    options?: { intervalMs?: number; onError?: (error: unknown) => void },
  ): AchievementSubscription;
  dispose(): void;
}
/** Reads are side-effect free. Each subscription hydrates silently and polls for new unlocks. */
export function createAchievements(
  client: SupabaseConnection,
  transport: Transport,
): Achievements {
  const stops = new Set<() => void>();
  let disposed = false;
  async function read() {
    const session = await requireSession(client);
    const rows = await transport.request<Achievement[]>(
      "/achievements",
      "GET",
      "AchievementList",
      { session },
    );
    const current = await requireSession(client);
    if (current.user.id !== session.user.id) {
      throw new Error("Player changed during achievement retrieval.");
    }
    return { user: session.user.id, rows };
  }
  const api: Achievements = {
    async listAchievements() {
      return (await read()).rows;
    },
    async getPlayerAchievements() {
      return (await read()).rows;
    },
    async getAchievement(id) {
      return (await read()).rows.find((a) => a.id === id) ?? null;
    },
    onUnlocked(callback, options = {}) {
      if (disposed) throw new Error("Achievements client is disposed.");
      const interval = options.intervalMs ?? 3000;
      if (!Number.isFinite(interval) || interval < 250) {
        throw new Error("Achievement polling interval must be at least 250ms.");
      }
      let active = true,
        timer: ReturnType<typeof setTimeout> | undefined,
        user: string | undefined;
      const seen = new Set<string>();
      const stop = () => {
        active = false;
        clearTimeout(timer);
        stops.delete(stop);
        seen.clear();
      };
      stops.add(stop);
      async function poll() {
        try {
          const result = await read();
          if (!active) return;
          const hydrate = user !== result.user;
          if (hydrate) {
            user = result.user;
            seen.clear();
          }
          for (const a of result.rows) {
            if (!a.unlocked || seen.has(a.id)) continue;
            seen.add(a.id);
            if (!hydrate && !a.historical && active) {
              try {
                callback(a);
              } catch (error) {
                try {
                  options.onError?.(error);
                } catch { /* Isolate consumer callbacks. */ }
              }
            }
          }
        } catch (error) {
          try {
            options.onError?.(error);
          } catch { /* Keep polling after consumer errors. */ }
        } finally {
          if (active) {
            timer = setTimeout(() => {
              void poll();
            }, interval);
          }
        }
      }
      return { ready: poll(), unsubscribe: stop };
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
    },
  };
  return api;
}

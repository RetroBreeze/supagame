import type { Achievement } from "@retrobreeze/supagame-contracts";
import { requireSession, assertSession, assertSessionEpoch, type SupabaseConnection } from "./auth.js";
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
const identityResets = new WeakMap<object, Set<() => void>>();
/** Internal bridge for the optional notification queue; custom sources own their lifecycle. */
export function onAchievementIdentityReset(source: object, callback: () => void): () => void {
  const listeners = identityResets.get(source);
  listeners?.add(callback);
  return () => { listeners?.delete(callback); };
}
/** Reads are side-effect free. Each subscription hydrates silently and polls for new unlocks. */
export function createAchievements(
  client: SupabaseConnection,
  transport: Transport,
): Achievements {
  const stops = new Set<() => void>();
  let disposed = false, observedUser: string | undefined;
  const resets = new Set<() => void>();
  const reset = () => { for (const callback of resets) { try { callback(); } catch { /* Isolate renderers. */ } } };
  async function read() {
    const session = await requireSession(client);
    if (observedUser !== undefined && observedUser !== session.user.id) reset();
    observedUser = session.user.id;
    const rows = await transport.request<Achievement[]>(
      "/achievements",
      "GET",
      "AchievementList",
      { session },
    );
    await assertSession(client, session);
    return { user: session.user.id, rows, session };
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
      const resetBaseline = () => { user = undefined; seen.clear(); };
      resets.add(resetBaseline);
      const stop = () => {
        active = false;
        clearTimeout(timer);
        stops.delete(stop);
        resets.delete(resetBaseline);
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
            assertSessionEpoch(client, result.session);
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
            if (active) options.onError?.(error);
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
      auth?.unsubscribe();
      reset();
      for (const stop of stops) stop();
    },
  };
  identityResets.set(api, resets);
  const auth = client.auth.onAuthStateChange?.((event, session) => {
    if (disposed || event === 'INITIAL_SESSION') return;
    const next = session?.user.id;
    if (event === 'SIGNED_OUT' || (observedUser !== undefined && observedUser !== next)) reset();
    observedUser = next;
  }).data.subscription;
  return api;
}

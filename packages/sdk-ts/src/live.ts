import type { LeaderboardPage, MyScore } from '@retrobreeze/supagame-contracts';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { requireSession, type SupabaseConnection } from './auth.js';
import { InvalidParameterError } from './errors.js';
import type { PageOptions } from './leaderboards.js';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
export interface RankChange {
  type: 'rank_improved' | 'rank_dropped' | 'entered_top' | 'left_top';
  boardId: string;
  previousRank: number | null;
  rank: number | null;
  topN: number;
}
export interface LiveOptions {
  onUpdate: (page: LeaderboardPage) => void;
  onRankChange?: (event: RankChange) => void;
  onStatus?: (status: LiveStatus) => void;
  onError?: (error: unknown) => void;
  topN?: number;
}
export interface LiveSubscription {
  unsubscribe(): void;
}
export function rankChanges(
  boardId: string,
  before: number | null,
  after: number | null,
  topN: number,
): RankChange[] {
  const types: RankChange['type'][] = [];
  if (before !== null && after !== null && before !== after)
    types.push(after < before ? 'rank_improved' : 'rank_dropped');
  if ((before === null || before > topN) && after !== null && after <= topN)
    types.push('entered_top');
  if (before !== null && before <= topN && (after === null || after > topN)) types.push('left_top');
  return types.map((type) => ({ type, boardId, previousRank: before, rank: after, topN }));
}
// Supabase reuses channel objects by topic. Share ownership across SDK instances.
const active = new WeakMap<object, Set<string>>();
const removals = new WeakMap<object, Map<string, Promise<void>>>();
// Shared across replacement subscriptions and SDK wrappers using this client.
// An aborted Promise is still counted until the transport actually settles.
const snapshots = new WeakMap<object, Map<string, Promise<void>>>();
interface SnapshotReads {
  getTop(id: string, options?: PageOptions, signal?: AbortSignal): Promise<LeaderboardPage>;
  getMine(id: string, signal?: AbortSignal): Promise<MyScore | null>;
}
export function subscribe(
  client: SupabaseConnection,
  api: SnapshotReads,
  id: string,
  options: LiveOptions,
): LiveSubscription {
  const topN = options.topN ?? 10;
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
    !Number.isInteger(topN) ||
    topN < 1 ||
    topN > 100 ||
    typeof options.onUpdate !== 'function'
  )
    throw new InvalidParameterError(
      'subscription',
      'Use a board slug, onUpdate callback and topN from 1 to 100.',
    );
  if (!client.channel || !client.removeChannel || !client.realtime)
    throw new InvalidParameterError(
      'supabase',
      'Live Leaderboards requires the existing full Supabase client.',
    );
  const boards = active.get(client) ?? new Set<string>();
  if (boards.has(id))
    throw new InvalidParameterError(
      'subscription',
      'This client already subscribes to this board. Unsubscribe before replacing it.',
    );
  boards.add(id);
  active.set(client, boards);
  let connected = false;
  let disposed = false,
    generation = 0,
    connection = 0,
    busy = false,
    dirty = false;
  let previous: MyScore | null | undefined, userId: string | undefined;
  let channel: RealtimeChannel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const report = (error: unknown) => {
    if (!disposed) {
      previous = undefined;
      options.onStatus?.('error');
      options.onError?.(error);
    }
  };
  const pendingSnapshots = snapshots.get(client) ?? new Map<string, Promise<void>>();
  snapshots.set(client, pendingSnapshots);
  let controller: AbortController | undefined;
  const refresh = async () => {
    if (disposed || busy) return;
    busy = true;
    let settled: Promise<void> | undefined;
    try {
      // A disposed predecessor may still own uncancellable HTTP requests.
      while (pendingSnapshots.has(id)) {
        await pendingSnapshots.get(id);
        if (disposed) return;
      }
      if (disposed) return;
      dirty = false;
      const version = generation;
      controller = new AbortController();
      const signal = controller.signal;
      const top = Promise.resolve().then(() => api.getTop(id, { limit: topN }, signal));
      const personal = Promise.resolve().then(() => api.getMine(id, signal));
      settled = Promise.allSettled([top, personal]).then(() => {});
      pendingSnapshots.set(id, settled);
      try {
        const [page, mine] = await Promise.race([
          Promise.all([top, personal]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller?.abort();
              reject(new Error('Live Leaderboards snapshot timed out.'));
            }, 10000);
          }),
        ]);
        if (disposed || version !== generation) return;
        if (previous !== undefined)
          for (const event of rankChanges(id, previous?.rank ?? null, mine?.rank ?? null, topN)) {
            if (!disposed) options.onRankChange?.(event);
          }
        previous = mine;
        if (!disposed) {
          if (connected) options.onStatus?.('connected');
          options.onUpdate(page);
        }
      } catch (error) {
        if (version === generation) report(error);
      } finally {
        clearTimeout(timeout);
        controller.abort();
        // Promise.all/race may finish while its sibling is still pending.
        // Cancellation is advisory: neither case releases the underlying bound.
        await settled;
      }
    } finally {
      if (settled && pendingSnapshots.get(id) === settled) pendingSnapshots.delete(id);
      busy = false;
      if (dirty && !disposed) schedule();
    }
  };
  const schedule = () => {
    if (disposed) return;
    dirty = true;
    // Broadcasts request a trailing snapshot without invalidating the one in
    // flight. Only lifecycle/auth changes invalidate otherwise usable reads.
    if (timer === undefined)
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 150);
  };
  const pending = removals.get(client) ?? new Map<string, Promise<void>>();
  removals.set(client, pending);
  let removal = pending.get(id) ?? Promise.resolve();
  const detach = () => {
    if (channel) {
      const old = channel;
      channel = undefined;
      removal = client.removeChannel!(old)
        .then(() => {})
        .catch(report);
      const task = removal;
      pending.set(id, task);
      void task.then(() => { if (pending.get(id) === task) pending.delete(id); });
    }
  };
  const connect = async () => {
    const attempt = ++connection;
    connected = false;
    generation++;
    controller?.abort();
    previous = undefined;
    detach();
    options.onStatus?.('connecting');
    try {
      await removal;
      const session = await requireSession(client);
      if (disposed || attempt !== connection) return;
      userId = session.user.id;
      await client.realtime!.setAuth(session.access_token);
      if (disposed || attempt !== connection) return;
      channel = client.channel!(`supagame:leaderboard:${id}`, { config: { private: true } })
        .on('broadcast', { event: 'changed' }, (message) => {
          if (message.payload?.boardId === id) schedule();
        })
        .subscribe((status, error) => {
          if (disposed || attempt !== connection) return;
          if (status === 'SUBSCRIBED') {
            connected = true;
            options.onStatus?.('connected');
            schedule();
          } else {
            connected = false;
            generation++;
            controller?.abort();
            previous = undefined;
            options.onStatus?.(status === 'CLOSED' ? 'disconnected' : 'reconnecting');
            if (error) options.onError?.(error);
          }
        });
      schedule();
    } catch (error) {
      if (attempt === connection) report(error);
    }
  };
  const auth = client.auth.onAuthStateChange((event, session) => {
    // Never await Auth methods while its callback holds the Auth lock.
    if (disposed || event === 'INITIAL_SESSION') return;
    generation++;
    controller?.abort();
    previous = undefined;
    if (session?.user.id !== userId || event === 'SIGNED_OUT') {
      connection++;
      detach();
      if (!session) options.onStatus?.('disconnected');
      else
        queueMicrotask(() => {
          if (!disposed) void connect();
        });
    } else if (session) {
      void client.realtime!.setAuth(session.access_token).then(schedule).catch(report);
    }
  }).data.subscription;
  void connect();
  return {
    unsubscribe() {
      if (disposed) return;
      disposed = true;
      generation++;
      controller?.abort();
      connection++;
      clearTimeout(timer);
      clearTimeout(timeout);
      auth.unsubscribe();
      detach();
      boards.delete(id);
    },
  };
}

import { expect, it, vi } from 'vitest';
import { createGameServices } from '../../packages/sdk-ts/src/index.ts';
import { fixture, entry, key } from './fixtures.ts';

it.each(['functions', 'fetch'] as const)('publishes bounded snapshots during sustained broadcasts (%s)', async (transport) => {
  vi.useFakeTimers();
  const f = fixture();
  let hint!: (message: { payload: { boardId: string } }) => void;
  const channel = {
    on: vi.fn((_type, _filter, callback) => { hint = callback; return channel; }),
    subscribe: vi.fn(() => channel),
  };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  let inFlight = 0, peak = 0;
  f.fetcher.mockImplementation(async (url) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 250));
    inFlight--;
    return Response.json(String(url).includes('/entries') ? { entries: [entry], nextCursor: null } : entry);
  });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase,
    ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}),
  });
  const update = vi.fn();
  const sub = game.leaderboards.subscribe('vaccoin', { onUpdate: update });
  let broadcasts: ReturnType<typeof setInterval> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(10);
    broadcasts = setInterval(() => hint({ payload: { boardId: 'vaccoin' } }), 100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(update.mock.calls.every(([page]) => page.entries[0].score === 50)).toBe(true);
    expect(peak).toBe(2); // One top/personal snapshot, never overlapping refreshes.
    clearInterval(broadcasts);
    await vi.advanceTimersByTimeAsync(700);
    const settled = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalledTimes(settled); // No idle polling loop.
    hint({ payload: { boardId: 'vaccoin' } });
    await vi.advanceTimersByTimeAsync(200);
    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    expect(update).toHaveBeenCalledTimes(settled); // Disposal still invalidates reads.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    clearInterval(broadcasts);
    sub.unsubscribe();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
it('subscribes privately, fetches initially, debounces hints, detects rank change and cleans up', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let rank = 12;
  f.fetcher.mockImplementation(async (url) =>
    Response.json(
      String(url).includes('/entries') ? { entries: [], nextCursor: null } : { ...entry, rank },
    ),
  );
  let hint: (message: { payload: { boardId: string } }) => void = () => {};
  let status: (value: string) => void = () => {};
  const channel = {
    on: vi.fn((_type, _filter, fn) => {
      hint = fn;
      return channel;
    }),
    subscribe: vi.fn((fn) => {
      status = fn;
      return channel;
    }),
  };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  const remove = vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const updates = vi.fn(),
    events = vi.fn();
  const sub = createGameServices({ supabase: f.supabase }).leaderboards.subscribe('vaccoin', {
    onUpdate: updates,
    onRankChange: events,
  });
  await vi.advanceTimersByTimeAsync(1);
  status('SUBSCRIBED');
  await vi.advanceTimersByTimeAsync(300);
  expect(updates).toHaveBeenCalled();
  expect(events).not.toHaveBeenCalled();
  rank = 5;
  for (let i = 0; i < 10; i++) hint({ payload: { boardId: 'vaccoin' } });
  await vi.advanceTimersByTimeAsync(300);
  expect(events.mock.calls.map((c) => c[0].type)).toEqual(['rank_improved', 'entered_top']);
  sub.unsubscribe();
  expect(remove).toHaveBeenCalledTimes(1);
  const count = updates.mock.calls.length;
  hint({ payload: { boardId: 'vaccoin' } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(updates).toHaveBeenCalledTimes(count);
  vi.useRealTimers();
});

import { rankChanges } from '../../packages/sdk-ts/src/live.ts';
it.each([
  [8, 5, ['rank_improved']],
  [3, 4, ['rank_dropped']],
  [11, 10, ['rank_improved', 'entered_top']],
  [10, 11, ['rank_dropped', 'left_top']],
  [null, 1, ['entered_top']],
  [1, null, ['left_top']],
  [5, 5, []],
  [null, null, []],
  [20, null, []],
] as const)('rank semantics %s to %s', (before, after, expected) => {
  expect(rankChanges('vaccoin', before, after, 10).map((e) => e.type)).toEqual(expected);
});

it('rejects duplicate ownership, suppresses late responses and reconnect baseline notifications', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let status: (value: string) => void = () => {};
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn((fn) => {
      status = fn;
      return channel;
    }),
  };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const game = createGameServices({ supabase: f.supabase });
  let resolve!: (value: import('../../packages/contracts/src/types.ts').LeaderboardPage) => void;
  const top = vi
    .spyOn(game.leaderboards, 'getTop')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ entries: [{ ...entry, score: 99 }], nextCursor: null });
  vi.spyOn(game.leaderboards, 'getMine').mockResolvedValue(entry);
  const update = vi.fn(),
    rank = vi.fn();
  const sub = game.leaderboards.subscribe('vaccoin', { onUpdate: update, onRankChange: rank });
  expect(() => game.leaderboards.subscribe('vaccoin', { onUpdate: update })).toThrow(/already/);
  await vi.advanceTimersByTimeAsync(200);
  status('CHANNEL_ERROR');
  status('SUBSCRIBED');
  resolve({ entries: [entry], nextCursor: null });
  await vi.advanceTimersByTimeAsync(400);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]![0].entries[0].score).toBe(99);
  status('CHANNEL_ERROR');
  status('SUBSCRIBED');
  await vi.advanceTimersByTimeAsync(200);
  expect(top).toHaveBeenCalledTimes(3);
  expect(rank).not.toHaveBeenCalled();
  sub.unsubscribe();
  status('SUBSCRIBED');
  await vi.advanceTimersByTimeAsync(200);
  expect(top).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});

it('fails closed without a session, cleans listeners and never creates an anonymous identity implicitly', async () => {
  const f = fixture(null),
    onError = vi.fn(),
    onUpdate = vi.fn();
  const remove = vi.spyOn(f.supabase, 'removeChannel');
  const sub = createGameServices({ supabase: f.supabase }).leaderboards.subscribe('vaccoin', {
    onUpdate,
    onError,
  });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(onUpdate).not.toHaveBeenCalled();
  expect(f.signIn).not.toHaveBeenCalled();
  sub.unsubscribe();
  sub.unsubscribe();
  expect(remove).not.toHaveBeenCalled();
});

it('resets rank baselines after failed reads and auth changes, discarding work after disposal', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let hint: (m: { payload: { boardId: string } }) => void = () => {};
  const channel = {
    on: vi.fn((_t, _f, fn) => {
      hint = fn;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const stop = vi.fn();
  let auth!: Parameters<typeof f.supabase.auth.onAuthStateChange>[0];
  vi.spyOn(f.supabase.auth, 'onAuthStateChange').mockImplementation((callback) => {
    auth = callback;
    return { data: { subscription: { id: 'test', callback, unsubscribe: stop } } };
  });
  const game = createGameServices({ supabase: f.supabase });
  vi.spyOn(game.leaderboards, 'getTop').mockResolvedValue({ entries: [], nextCursor: null });
  const mine = vi.spyOn(game.leaderboards, 'getMine').mockResolvedValue({ ...entry, rank: 12 });
  const update = vi.fn(),
    rank = vi.fn(),
    error = vi.fn();
  const sub = game.leaderboards.subscribe('vaccoin', {
    onUpdate: update,
    onRankChange: rank,
    onError: error,
  });
  await vi.advanceTimersByTimeAsync(200);
  mine.mockRejectedValueOnce(new Error('HTTP failed'));
  hint({ payload: { boardId: 'vaccoin' } });
  await vi.advanceTimersByTimeAsync(200);
  expect(error).toHaveBeenCalledTimes(1);
  mine.mockResolvedValue({ ...entry, rank: 1 });
  hint({ payload: { boardId: 'vaccoin' } });
  await vi.advanceTimersByTimeAsync(200);
  expect(rank).not.toHaveBeenCalled();
  auth('SIGNED_OUT', null);
  await vi.advanceTimersByTimeAsync(200);
  const count = update.mock.calls.length;
  sub.unsubscribe();
  expect(stop).toHaveBeenCalledTimes(1);
  hint({ payload: { boardId: 'vaccoin' } });
  await vi.advanceTimersByTimeAsync(500);
  expect(update).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('waits for prior channel removal before immediate resubscription', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const channel = {on:vi.fn(()=>channel), subscribe:vi.fn(()=>channel)};
  const create = vi.spyOn(f.supabase,'channel').mockReturnValue(channel as never);
  let removed!: (value:'ok')=>void;
  vi.spyOn(f.supabase,'removeChannel').mockImplementation(()=>new Promise(resolve=>{removed=resolve;}));
  vi.spyOn(f.supabase.realtime,'setAuth').mockResolvedValue();
  const game=createGameServices({supabase:f.supabase});
  const first=game.leaderboards.subscribe('vaccoin',{onUpdate:vi.fn()});
  await vi.advanceTimersByTimeAsync(1);first.unsubscribe();
  const second=game.leaderboards.subscribe('vaccoin',{onUpdate:vi.fn()});
  await vi.advanceTimersByTimeAsync(1);
  expect(create).toHaveBeenCalledTimes(1);
  removed('ok');await vi.advanceTimersByTimeAsync(1);
  expect(create).toHaveBeenCalledTimes(2);
  second.unsubscribe();removed('ok');vi.useRealTimers();
});

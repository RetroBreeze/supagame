import { afterEach, expect, it, vi } from 'vitest';
import { createGameServices } from '../../packages/sdk-ts/src/index.js';
import { fixture, entry, key, session } from './fixtures.js';
import { deferred } from './concurrency-fixtures.js';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['functions', 'fetch'] as const)('discards pending account snapshots and establishes a new rank baseline (%s)', async transport => {
  vi.useFakeTimers(); const f = fixture();
  const listeners = new Set<Parameters<typeof f.supabase.auth.onAuthStateChange>[0]>();
  vi.spyOn(f.supabase.auth, 'onAuthStateChange').mockImplementation(callback => {
    listeners.add(callback);
    return { data: { subscription: { id: 'live-switch', callback, unsubscribe() { listeners.delete(callback); } } } };
  });
  const channel = { on: vi.fn(() => channel), subscribe: vi.fn(() => channel) };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const pending: { finish: ReturnType<typeof deferred<Response>>; mine: boolean; signal: AbortSignal | null | undefined }[] = [];
  f.fetcher.mockImplementation(async (url, init) => {
    const finish = deferred<Response>(); pending.push({ finish, mine: !String(url).includes('/entries'), signal: init?.signal });
    return finish.promise;
  });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase, ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const update = vi.fn(), rank = vi.fn(), error = vi.fn();
  const sub = game.leaderboards.subscribe('board', { onUpdate: update, onRankChange: rank, onError: error });
  try {
    await vi.advanceTimersByTimeAsync(200); expect(pending).toHaveLength(2);
    const other = session(false, 'other-token'); other.user.id = '00000000-0000-4000-8000-000000000099';
    f.getSession.mockResolvedValue({ data: { session: other }, error: null });
    for (const callback of listeners) callback('SIGNED_IN', other);
    await vi.advanceTimersByTimeAsync(500);
    expect(pending).toHaveLength(2); expect(pending.every(p => p.signal?.aborted)).toBe(true);
    for (const p of pending.slice()) p.finish.resolve(Response.json(p.mine ? entry : { entries: [entry], nextCursor: null }));
    await vi.advanceTimersByTimeAsync(200); expect(pending).toHaveLength(4); expect(update).not.toHaveBeenCalled();
    const next = { ...entry, playerId: other.user.id, rank: 3 };
    for (const p of pending.slice(2)) p.finish.resolve(Response.json(p.mine ? next : { entries: [next], nextCursor: null }));
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenCalledExactlyOnceWith({ entries: [next], nextCursor: null });
    expect(rank).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { sub.unsubscribe(); }
});
it.each(['functions', 'fetch'] as const)('bounds stalled snapshots across timeouts, reconnects and replacement (%s)', async transport => {
  vi.useFakeTimers(); const f = fixture();
  let hint!: (m: { payload: { boardId: string } }) => void, status!: (s: string) => void;
  const channel = { on: vi.fn((_t, _f, cb) => { hint = cb; return channel; }), subscribe: vi.fn(cb => { status = cb; return channel; }) };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok');
  vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const pending: { finish: ReturnType<typeof deferred<Response>>; signal: AbortSignal | null | undefined; mine: boolean }[] = [];
  let active = 0, peak = 0;
  f.fetcher.mockImplementation(async (url, init) => {
    active++; peak = Math.max(peak, active); const finish = deferred<Response>();
    pending.push({ finish, signal: init?.signal, mine: !String(url).includes('/entries') });
    try { return await finish.promise; } finally { active--; }
  });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase,
    ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const update = vi.fn(), error = vi.fn(); let sub = game.leaderboards.subscribe('board', { onUpdate: update, onError: error });
  try {
    await vi.advanceTimersByTimeAsync(200);
    const broadcasts = setInterval(() => hint({ payload: { boardId: 'board' } }), 100);
    await vi.advanceTimersByTimeAsync(33000);
    expect(peak).toBe(2);
    expect(pending).toHaveLength(2);
    expect(pending.every(p => p.signal?.aborted)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    status('CHANNEL_ERROR'); status('SUBSCRIBED'); await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(2);
    sub.unsubscribe(); const count = error.mock.calls.length;
    sub = game.leaderboards.subscribe('board', { onUpdate: update, onError: error });
    await vi.advanceTimersByTimeAsync(1000); expect(pending).toHaveLength(2);
    for (const p of pending.slice()) p.finish.resolve(Response.json(p.mine ? entry : { entries: [entry], nextCursor: null }));
    await vi.advanceTimersByTimeAsync(300); expect(pending).toHaveLength(4); expect(update).not.toHaveBeenCalled();
    for (const p of pending.slice(2)) p.finish.resolve(Response.json(p.mine ? entry : { entries: [entry], nextCursor: null }));
    clearInterval(broadcasts); await vi.advanceTimersByTimeAsync(50); expect(update).toHaveBeenCalledTimes(1);
    sub.unsubscribe(); await vi.advanceTimersByTimeAsync(20000);
    expect(error).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
  } finally { sub.unsubscribe(); }
});
it.each(['functions', 'fetch'] as const)('cancels cooperative transports on repeated timeouts and disposal (%s)', async transport => {
  vi.useFakeTimers(); const f = fixture(); let hint!: (m: { payload: { boardId: string } }) => void;
  const channel = { on: vi.fn((_t, _f, cb) => { hint = cb; return channel; }), subscribe: vi.fn(() => channel) };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok'); vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  let active = 0, peak = 0, aborted = 0;
  f.fetcher.mockImplementation(async (_url, init) => {
    active++; peak = Math.max(peak, active);
    try { return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
    }); } finally { active--; }
  });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase, ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const error = vi.fn(), update = vi.fn(), sub = game.leaderboards.subscribe('board', { onUpdate: update, onError: error });
  await vi.advanceTimersByTimeAsync(200);
  const broadcasts = setInterval(() => hint({ payload: { boardId: 'board' } }), 100);
  try {
    await vi.advanceTimersByTimeAsync(33000); expect(peak).toBe(2); expect(aborted).toBeGreaterThanOrEqual(6);
    expect(error).toHaveBeenCalledTimes(3); sub.unsubscribe(); clearInterval(broadcasts);
    await vi.advanceTimersByTimeAsync(30000); expect(active).toBe(0); expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  } finally { clearInterval(broadcasts); sub.unsubscribe(); }
});
it('keeps the concurrency slot when one read fails but its sibling ignores cancellation', async () => {
  vi.useFakeTimers(); const f = fixture(); let hint!: (m: { payload: { boardId: string } }) => void;
  const channel = { on: vi.fn((_t, _f, cb) => { hint = cb; return channel; }), subscribe: vi.fn(() => channel) };
  vi.spyOn(f.supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(f.supabase, 'removeChannel').mockResolvedValue('ok'); vi.spyOn(f.supabase.realtime, 'setAuth').mockResolvedValue();
  const pending = deferred<Response>();
  f.fetcher.mockImplementation(async url => {
    if (String(url).includes('/entries')) return Response.json({ code: 'INTERNAL_ERROR', message: 'Unavailable' }, { status: 500 });
    return pending.promise;
  });
  const game = createGameServices({ supabase: f.supabase }), error = vi.fn();
  const sub = game.leaderboards.subscribe('board', { onUpdate: vi.fn(), onError: error });
  try {
    await vi.advanceTimersByTimeAsync(200);
    for (let i=0;i<30;i++) { hint({ payload:{boardId:'board'} }); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledTimes(1);
  } finally { sub.unsubscribe(); pending.resolve(Response.json(null)); await vi.advanceTimersByTimeAsync(1); }
});

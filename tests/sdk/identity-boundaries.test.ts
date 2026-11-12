import { afterEach, expect, it, vi } from 'vitest';
import { AuthenticationError, createGameServices, type GameServicesOptions } from '../../packages/sdk-ts/src/index.js';
import { fixture, session, userId, key, profile } from './fixtures.js';
import { deferred, memoryStore } from './concurrency-fixtures.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('preserves Auth adapters without event subscriptions and validates their active session', async () => {
  const f = fixture(), started = deferred<void>(), finish = deferred<void>();
  // Vaccoin's installed-SDK tests provide this existing minimal Auth adapter.
  const connection = { auth: { getSession: f.getSession, getUser: f.getUser,
    signInAnonymously: f.signIn, refreshSession: f.refresh }, functions: f.supabase.functions } as unknown as GameServicesOptions['supabase'];
  const game = createGameServices({ supabase: connection });
  await expect(game.players.ensureAnonymousSession()).resolves.toEqual({ userId });
  f.fetcher.mockImplementation(async () => { started.resolve(); await finish.promise; return Response.json(profile); });
  const result = game.players.getMe().catch(e => e); await started.promise;
  const other = session(); other.user.id = 'other';
  f.getSession.mockResolvedValue({ data: { session: other }, error: null }); finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
  game.achievements.dispose();
});

it.each(['recovery', 'status', 'ensure'] as const)('rejects account switching during Auth verification (%s)', async (method) => {
  const f = fixture(), store = memoryStore<unknown>(), started = deferred<void>(), finish = deferred<void>();
  const transition = { id: 'review', sourcePlayerId: userId };
  await store.update(JSON.stringify(['project', 'transition', 'review']), () => ({
    version: 1, ...transition, phase: 'prepared', slots: [{ slot: 'profile', cloud: null,
      guest: { slot: 'profile', kind: 'json', data: { private: 'original player' } } }],
  }));
  f.getUser.mockImplementation(async () => { started.resolve(); await finish.promise; return { data: { user: session().user }, error: null }; });
  const game = createGameServices({ supabase: f.supabase, accounts: { namespace: 'project', store } });
  const result = (method === 'recovery' ? game.saves.getAccountSwitchRecovery(transition)
    : method === 'status' ? game.players.getAuthStatus() : game.players.ensureAnonymousSession()).catch(e => e);
  await started.promise;
  const other = session(); other.user.id = '00000000-0000-4000-8000-000000000099';
  f.getSession.mockResolvedValue({ data: { session: other }, error: null });
  finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
});

it.each(['functions', 'fetch'] as const)('invalidates switch-away-and-back while preserving same-player refresh (%s)', async (transport) => {
  const f = fixture(), started = deferred<void>(), finish = deferred<void>();
  const listeners: Parameters<typeof f.supabase.auth.onAuthStateChange>[0][] = [];
  vi.spyOn(f.supabase.auth, 'onAuthStateChange').mockImplementation(callback => {
    listeners.push(callback);
    return { data: { subscription: { id: 'review', callback, unsubscribe() {} } } };
  });
  f.fetcher.mockImplementation(async () => { started.resolve(); await finish.promise; return Response.json(profile); });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase,
    ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const result = game.players.getMe().catch(e => e);
  await started.promise;
  for (const listener of listeners) { listener('SIGNED_OUT', null); listener('SIGNED_IN', session()); }
  finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
  f.fetcher.mockImplementation(async () => {
    for (const listener of listeners) listener('TOKEN_REFRESHED', session(true, 'fresh-token'));
    return Response.json(profile);
  });
  await expect(game.players.getMe()).resolves.toEqual(profile);
});

it('rejects recovery if identity changes during journal loading, even to the authorized target', async () => {
  const f = fixture(), store = memoryStore<unknown>(), started = deferred<void>(), finish = deferred<void>();
  const target = session(false); target.user.id = '00000000-0000-4000-8000-000000000099';
  const t = { id: 'journal', sourcePlayerId: userId };
  await store.update(JSON.stringify(['project', 'transition', t.id]), () => ({ version: 1, ...t, targetPlayerId: target.user.id,
    phase: 'review', slots: [{ slot: 'profile', guest: { slot: 'profile', kind: 'json', data: { guest: true } },
      cloud: { slot: 'profile', kind: 'json', data: { private: true } } }] }));
  const read = store.read.bind(store);
  store.read = async k => { const value = await read(k); started.resolve(); await finish.promise; return value; };
  const game = createGameServices({ supabase: f.supabase, accounts: { namespace: 'project', store } });
  const result = game.saves.getAccountSwitchRecovery(t).catch(e => e);
  await started.promise;
  f.getSession.mockResolvedValue({ data: { session: target }, error: null });
  f.getUser.mockResolvedValue({ data: { user: target.user }, error: null });
  finish.resolve(); expect(await result).toBeInstanceOf(AuthenticationError);
});

it('does not expose binary conflict details when identity changes during the nested load', async () => {
  const f = fixture(), started = deferred<void>(), finish = deferred<void>();
  const game = createGameServices({ supabase: f.supabase });
  vi.spyOn(game.saves, 'load').mockImplementation(async () => {
    started.resolve(); await finish.promise;
    return { slot: 'blob', revision: 2, schemaVersion: 1, kind: 'binary', metadata: { private: true }, sizeBytes: 1,
      deleted: false, objectPath: `${userId}/object`, createdAt: profile.createdAt, updatedAt: profile.createdAt };
  });
  const result = game.saves.loadBinary('blob', { expectedRevision: 1 }).catch(e => e);
  await started.promise;
  const other = session(); other.user.id = '00000000-0000-4000-8000-000000000099';
  f.getSession.mockResolvedValue({ data: { session: other }, error: null }); finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
});

it('does not start provider authentication after identity changes during flow persistence', async () => {
  const f = fixture(), store = memoryStore<unknown>(), started = deferred<void>(), finish = deferred<void>();
  const update = store.update.bind(store);
  store.update = async (k, fn) => { const result = await update(k, fn); started.resolve(); await finish.promise; return result; };
  const oauth = vi.spyOn(f.supabase.auth, 'signInWithOAuth').mockResolvedValue({ data: { provider: 'google', url: 'https://provider.example' }, error: null });
  const game = createGameServices({ supabase: f.supabase, accounts: { namespace: 'project', store } });
  const result = game.players.signInWithProvider('google', { redirectTo: 'https://game.example/' }).catch(e => e);
  await started.promise; const other = session(); other.user.id = 'other';
  f.getSession.mockResolvedValue({ data: { session: other }, error: null }); finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError); expect(oauth).not.toHaveBeenCalled();
});

it.each(['functions', 'fetch'] as const)('keeps the revision cache monotonic after out-of-order reads (%s)', async transport => {
  const f = fixture(), started = deferred<void>(), finish = deferred<void>();
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase, ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const { saveRecord } = await import('./concurrency-fixtures.js');
  f.fetcher.mockImplementationOnce(async () => { started.resolve(); await finish.promise; return Response.json({ save: saveRecord }); });
  const stale = game.saves.load('profile'); await started.promise;
  f.fetcher.mockImplementation(async () => Response.json({ save: { ...saveRecord, revision: 2 } }));
  await game.saves.load('profile'); finish.resolve(); await stale;
  await game.saves.save('profile', { coins: 3 });
  expect(JSON.parse(f.fetcher.mock.calls.at(-1)![1]!.body as string).expectedRevision).toBe(2);
});
it('binds an OAuth callback to the identity returned by its code exchange', async () => {
  const f = fixture(), store = memoryStore<unknown>();
  vi.spyOn(f.supabase.auth, 'signInWithOAuth').mockResolvedValue({ data: { provider: 'google', url: 'https://provider.example' }, error: null });
  const game = createGameServices({ supabase: f.supabase, accounts: { namespace: 'project', store } });
  const flow = await game.players.signInWithProvider('google', { redirectTo: 'https://game.example/' });
  const intended = session(false); intended.user.id = 'intended';
  const other = session(false); other.user.id = 'other';
  other.user.identities = [{ id:'google', identity_id:'google', user_id:'other', provider:'google', created_at:'', updated_at:'' }];
  vi.spyOn(f.supabase.auth, 'exchangeCodeForSession').mockImplementation(async () => {
    f.getSession.mockResolvedValue({ data: { session: other }, error: null });
    f.getUser.mockResolvedValue({ data: { user: other.user }, error: null });
    return { data: { session: intended, user: intended.user }, error: null };
  });
  await expect(game.players.handleAuthCallback(`https://game.example/?sg_flow=${flow.flowId}&code=code`)).rejects.toBeInstanceOf(AuthenticationError);
});
it.each(['functions', 'fetch'] as const)('reports identity loss consistently when pending transport fails (%s)', async transport => {
  const f = fixture(), started = deferred<void>(), finish = deferred<void>();
  f.fetcher.mockImplementation(async () => { started.resolve(); await finish.promise; throw new Error('offline'); });
  if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
  const game = createGameServices({ supabase: f.supabase, ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}) });
  const result = game.players.getMe().catch(e => e); await started.promise;
  f.getSession.mockResolvedValue({ data: { session: null }, error: null }); finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
});
it('retains a joined transition promise while its caller identity is being checked', async () => {
  const f = fixture(session(false)), store = memoryStore<unknown>();
  const transition = { id: 'joined', sourcePlayerId: 'guest' };
  await store.update(JSON.stringify(['project', 'transition', transition.id]), () => ({ version:1,...transition,
    targetPlayerId:userId,phase:'review',generation:1,slots:[] }));
  const readStarted = deferred<void>(), readFinish = deferred<void>(), verifyStarted = deferred<void>(), verifyFinish = deferred<void>();
  const read = store.read.bind(store); let first = true;
  store.read = async k => { const value = await read(k); if (first) { first = false; readStarted.resolve(); await readFinish.promise; } return value; };
  const game = createGameServices({ supabase: f.supabase, accounts: { namespace: 'project', store } });
  const options = { strategy:'keepCloud' as const,targetPlayerId:userId,confirmed:true };
  const original = game.saves.resolveAccountSwitch(transition, options); await readStarted.promise;
  let checks = 0;
  f.getSession.mockImplementation(async () => {
    if (++checks === 2) { verifyStarted.resolve(); await verifyFinish.promise; }
    return { data: { session: session(false) }, error: null };
  });
  const joined = game.saves.resolveAccountSwitch(transition, options); await verifyStarted.promise;
  readFinish.resolve(); await expect(original).resolves.toMatchObject({ status: 'complete' });
  verifyFinish.resolve(); await expect(joined).resolves.toMatchObject({ status: 'complete' });
});

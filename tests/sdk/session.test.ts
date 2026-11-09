import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '@supabase/supabase-js';
import { createGameServices, AuthenticationError, InvalidParameterError, type UpdatePlayerRequest } from '../../packages/sdk-ts/src/index.js';
import { fixture, key, profile, session, userId } from './fixtures.js';

afterEach(() => vi.restoreAllMocks());
it.each([
  { label: 'null', input: null },
  { label: 'undefined', input: undefined },
  { label: 'string', input: 'Player' },
  { label: 'number', input: 42 },
  { label: 'boolean', input: false },
  { label: 'bigint', input: 42n },
  { label: 'symbol', input: Symbol('Player') },
  { label: 'array', input: [] },
  { label: 'function with a display name', input: Object.assign(() => undefined, { displayName: 'Player' }) },
  { label: 'array with a display name', input: Object.assign([], { displayName: 'Player' }) },
])('rejects $label profile input with a typed error before auth or HTTP', async ({ input }) => {
  const f = fixture();
  const game = createGameServices({ supabase: f.supabase });
  await expect(game.players.updateMe(input as unknown as UpdatePlayerRequest)).rejects.toBeInstanceOf(InvalidParameterError);
  expect(f.getSession).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});

describe('caller-owned player authentication', () => {
  it('signs in anonymously on first use and coalesces simultaneous calls across wrappers', async () => {
    const f = fixture(null);
    const a = createGameServices({ supabase: f.supabase });
    const b = createGameServices({ supabase: f.supabase });
    expect(await Promise.all([a.players.ensureAnonymousSession(), b.players.ensureAnonymousSession()])).toEqual([{ userId }, { userId }]);
    expect(f.signIn).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('reuses an existing session (anonymous=%s)', async (anonymous) => {
    const f = fixture(session(anonymous));
    expect(await createGameServices({ supabase: f.supabase }).players.ensureAnonymousSession()).toEqual({ userId });
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it('surfaces a revoked session without creating a replacement identity', async () => {
    const f = fixture();
    f.getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('revoked', 401, 'bad_jwt') });
    await expect(createGameServices({ supabase: f.supabase }).players.ensureAnonymousSession()).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it('surfaces refresh failures without anonymous fallback', async () => {
    const f = fixture();
    f.getSession.mockResolvedValue({ data: { session: null }, error: new AuthApiError('invalid refresh token', 400, 'refresh_token_not_found') });
    await expect(createGameServices({ supabase: f.supabase }).players.ensureAnonymousSession()).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it('requires a session for profile operations without implicitly signing in', async () => {
    const f = fixture(null);
    await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.signIn).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('delegates expired-token refresh and sends the resulting JWT and project key', async () => {
    const old = session(); old.expires_at = 1;
    const f = fixture(old);
    expect(await createGameServices({ supabase: f.supabase }).players.getMe()).toEqual(profile);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    const request = f.requests[0]!;
    expect(request.url).toBe('https://sdk-test.supabase.co/functions/v1/supagame/v1/players/me');
    expect(new Headers(request.init.headers).get('apikey')).toBe(key);
    expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer refreshed-token');
  });
  it('reads current tokens for each call and never persists its own credentials', async () => {
    const f = fixture(); const game = createGameServices({ supabase: f.supabase });
    await game.players.getMe();
    f.getSession.mockResolvedValue({ data: { session: session(false, 'new-token') }, error: null });
    await game.players.updateMe({ displayName: 'New name' });
    expect(new Headers(f.requests[1]!.init.headers).get('authorization')).toBe('Bearer new-token');
    expect(f.requests[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(f.requests[1]!.init.body as string)).toEqual({ displayName: 'New name' });
  });
  it('propagates anonymous sign-in failure and permits a later explicit attempt', async () => {
    const f = fixture(null); const game = createGameServices({ supabase: f.supabase });
    f.signIn.mockResolvedValueOnce({ data: { session: null, user: null }, error: new AuthApiError('disabled', 422, 'anonymous_provider_disabled') });
    await expect(game.players.ensureAnonymousSession()).rejects.toBeInstanceOf(AuthenticationError);
    expect(await game.players.ensureAnonymousSession()).toEqual({ userId });
  });
});

it('does not leak an unexpected auth exception or replace its identity', async () => {
  const f = fixture(); f.getSession.mockRejectedValue(new Error('sensitive authentication detail'));
  const promise = createGameServices({ supabase: f.supabase }).players.ensureAnonymousSession();
  await expect(promise).rejects.toBeInstanceOf(AuthenticationError);
  await expect(promise).rejects.not.toHaveProperty('message', 'sensitive authentication detail');
  expect(f.signIn).not.toHaveBeenCalled();
});
it('rejects expired sessions that remain expired after refresh', async () => {
  const expired = session(); expired.expires_at = 1; const f = fixture(expired);
  f.refresh.mockResolvedValue({ data: { session: expired, user: expired.user }, error: null });
  await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(AuthenticationError);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
});
it('rejects a refresh that unexpectedly changes identity', async () => {
  const expired = session(); expired.expires_at = 1; const f = fixture(expired);
  const other = session(); other.user.id = '00000000-0000-4000-8000-000000000099';
  f.refresh.mockResolvedValue({ data: { session: other, user: other.user }, error: null });
  await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(AuthenticationError);
  expect(f.fetcher).not.toHaveBeenCalled();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameServices, ApiError, AuthenticationError, InvalidParameterError, NetworkError, UnexpectedResponseError } from '../../packages/sdk-ts/src/index.js';
import { entry, fixture, key, profile, session } from './fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('HTTP contract wrappers', () => {
  it.each([[10, 20], [20, 10]])('preserves server ordering and ranks (%s, %s)', async (first, second) => {
    const f = fixture(null); const page = { entries: [{ ...entry, score: first }, { ...entry, score: second, rank: 2 }], nextCursor: null };
    f.fetcher.mockResolvedValue(Response.json(page));
    expect(await createGameServices({ supabase: f.supabase }).leaderboards.getTop('level 1')).toEqual(page);
    const request = f.fetcher.mock.calls[0]!;
    expect(String(request[0])).toContain('/leaderboards/level%201/entries');
    expect(new Headers(request[1]?.headers).get('apikey')).toBe(key);
    expect(new Headers(request[1]?.headers).has('authorization')).toBe(false);
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it('round-trips opaque cursors without altering precision or tied entries', async () => {
    const f = fixture(null); const cursor = '{"score":10,"achievedAt":"2026-11-09T12:00:00.123456Z","id":"a+b"}';
    f.fetcher.mockImplementation(async () => Response.json({ entries: [entry], nextCursor: cursor }));
    const game = createGameServices({ supabase: f.supabase });
    expect((await game.leaderboards.getTop('time', { limit: 1 })).nextCursor).toBe(cursor);
    await game.leaderboards.getTop('time', { limit: 1, cursor });
    const url = new URL(String(f.fetcher.mock.calls[1]![0]));
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('1');
  });
  it.each([null, entry])('returns personal standing or null', async (value) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json(value));
    expect(await createGameServices({ supabase: f.supabase }).leaderboards.getMine('board')).toEqual(value);
  });
  it('retries a failed submission once with exactly the same generated UUID and body', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ outcome: 'best', score: 50, bestScore: 50 }));
    expect(await createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 50)).toEqual({ outcome: 'best', score: 50, bestScore: 50 });
    const bodies = f.fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].submissionKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(bodies[0]).sort()).toEqual(['score', 'submissionKey']);
  });
  it('preserves an explicit key and exposes it on terminal errors for manual retries', async () => {
    const f = fixture(); f.fetcher.mockRejectedValue(new Error('secret transport detail'));
    const submissionKey = '00000000-0000-4000-8000-000000000002';
    const promise = createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1, submissionKey);
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    await expect(promise).rejects.toMatchObject({ submissionKey });
    await expect(promise).rejects.not.toHaveProperty('message', 'secret transport detail');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('never retries a submission as a different player', async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => {
      const next = session(); next.user.id = '00000000-0000-4000-8000-000000000099';
      f.getSession.mockResolvedValue({ data: { session: next }, error: null });
      throw new TypeError('lost response');
    });
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1)).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid score %s before any request', async (score) => {
    const f = fixture();
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', score as number)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.getSession).not.toHaveBeenCalled();
  });
  it.each([0, 101, 1.5, NaN, '10'])('rejects invalid page limit %s', async (limit) => {
    const f = fixture();
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.getTop('board', { limit: limit as number })).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['', '.', '..'])('rejects unsafe/empty board IDs %s', async (id) => {
    const f = fixture(); await expect(createGameServices({ supabase: f.supabase }).leaderboards.getTop(id)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['ab', 'x'.repeat(25), 'bad\nname'])('validates profile updates before network access', async (displayName) => {
    const f = fixture(); await expect(createGameServices({ supabase: f.supabase }).players.updateMe({ displayName })).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([[400, 'INVALID_SCORE'], [403, 'FORBIDDEN'], [404, 'LEADERBOARD_NOT_FOUND'], [409, 'DUPLICATE_KEY_CONFLICT'], [429, 'RATE_LIMITED'], [500, 'INTERNAL_ERROR']])('preserves HTTP %s and API code %s without automatic retry', async (status, code) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json({ code, message: 'Public message' }, { status: status as number }));
    const promise = createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status, code, message: 'Public message' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('maps gateway authentication rejection without leaking its body', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('private gateway details', { status: 401 }));
    await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it.each([{ ...profile, moderation: true }, { ...profile, playerId: 'invalid' }, { ...profile, createdAt: 'yesterday' }, [], null])('rejects unexpected profile data %#', async (value) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json(value));
    await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
  it.each([new Response('{', { headers: { 'content-type': 'application/json' } }), new Response(JSON.stringify(profile)), new Response(null, { status: 204 })])('rejects invalid JSON/media types/empty responses %#', async (response) => {
    const f = fixture(); f.fetcher.mockResolvedValue(response);
    await expect(createGameServices({ supabase: f.supabase }).players.getMe()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
  it('supports explicit trusted base URL with public key and caller JWT', async () => {
    const f = fixture(); const fetcher = vi.fn().mockResolvedValue(Response.json(profile)); vi.stubGlobal('fetch', fetcher);
    const game = createGameServices({ supabase: f.supabase, baseUrl: 'https://game.example/api/v1/', publishableKey: key });
    expect(await game.players.getMe()).toEqual(profile);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://game.example/api/v1/players/me');
    expect(new Headers(options.headers).get('apikey')).toBe(key);
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer test-user-token');
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
  });
  it.each([
    { baseUrl: 'https://game.example/v1' },
    { baseUrl: 'http://untrusted.example/v1', publishableKey: key },
    { baseUrl: 'https://user:password@game.example/v1', publishableKey: key },
    { baseUrl: 'https://game.example/v1?key=bad', publishableKey: key },
    { baseUrl: 'https://game.example/v1', publishableKey: 'sb_secret_placeholder' },
  ])('rejects ambiguous or unsafe override configuration %#', (options) => {
    const f = fixture(); expect(() => createGameServices({ supabase: f.supabase, ...options })).toThrow(InvalidParameterError);
  });
});

describe('browser and untyped caller boundaries', () => {
  it('rejects null pagination limits rather than silently using defaults', async () => {
    const f = fixture();
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.getTop('board', { limit: null as unknown as number })).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects a null submission key rather than silently generating another attempt', async () => {
    const f = fixture();
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1, null as unknown as string)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['', 'not-a-uuid'])('rejects invalid idempotency keys %s', async (submissionKey) => {
    const f = fixture(); await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1, submissionKey)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['', null, 10])('rejects invalid cursors %#', async (cursor) => {
    const f = fixture(); await expect(createGameServices({ supabase: f.supabase }).leaderboards.getTop('board', { cursor: cursor as string })).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not allow profile updates to carry other player IDs or protected fields', async () => {
    const f = fixture();
    await expect(createGameServices({ supabase: f.supabase }).players.updateMe({ displayName: 'Player', playerId: 'someone-else' } as { displayName: string })).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('normalizes valid Unicode display names without changing character counts', async () => {
    const f = fixture(); await createGameServices({ supabase: f.supabase }).players.updateMe({ displayName: '  🐈🐈🐈  ' });
    expect(JSON.parse(f.requests[0]!.init.body as string)).toEqual({ displayName: '🐈🐈🐈' });
  });
  it.each([
    { entries: [{ ...entry, score: Number.MAX_SAFE_INTEGER + 1 }], nextCursor: null },
    { entries: [{ ...entry, rank: 0 }], nextCursor: null },
    { entries: [{ ...entry, hidden: true }], nextCursor: null },
    { entries: Array.from({ length: 101 }, () => entry), nextCursor: null },
    { entries: [], nextCursor: 123 },
  ])('rejects malformed leaderboard pages %#', async (body) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json(body));
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.getTop('board')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
  it.each([{ outcome: 'wrong', score: 1, bestScore: 1 }, { outcome: 'best', score: 1 }, { outcome: 'best', score: 1, bestScore: Number.MAX_SAFE_INTEGER + 1 }])('rejects malformed score results %#', async (body) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json(body));
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1)).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not automatically retry non-idempotent profile operations', async () => {
    const f = fixture(); f.fetcher.mockRejectedValue(new Error('network failure'));
    await expect(createGameServices({ supabase: f.supabase }).players.updateMe({ displayName: 'Player' })).rejects.toBeInstanceOf(NetworkError);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('generates a secure UUID in WebViews without crypto.randomUUID', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json({ outcome: 'best', score: 1, bestScore: 1 }));
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    await createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1);
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string).submissionKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('fails clearly when secure randomness is unavailable', async () => {
    const f = fixture(); vi.stubGlobal('crypto', undefined);
    await expect(createGameServices({ supabase: f.supabase }).leaderboards.submit('board', 1)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])('preserves boundary integer %s in JSON', async (score) => {
    const f = fixture(); f.fetcher.mockResolvedValue(Response.json({ outcome: 'not_best', score, bestScore: score }));
    expect(await createGameServices({ supabase: f.supabase }).leaderboards.submit('board', score)).toEqual({ outcome: 'not_best', score, bestScore: score });
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string).score).toBe(score);
  });
});

it.each([
  { status: 429, body: { code: 'RATE_LIMITED', message: 'Try again later' }, error: ApiError },
  { status: 200, body: { unexpected: true }, error: UnexpectedResponseError },
  { status: 401, body: { message: 'gateway rejection' }, error: AuthenticationError },
  { status: 500, body: { internal: 'unstructured gateway error' }, error: UnexpectedResponseError },
])('custom transport applies the same error/response validation ($status)', async ({ status, body, error }) => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
  await expect(createGameServices({ supabase: f.supabase, baseUrl: 'https://game.example/v1', publishableKey: key }).players.getMe()).rejects.toBeInstanceOf(error);
});

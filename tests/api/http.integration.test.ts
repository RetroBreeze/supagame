import assert from 'node:assert/strict';
import { query } from '../db/local-sessions.ts';
import { assertSchema } from './http-schema.ts';

// Read local status in memory, selecting only the public client key. No secret
// keys, signing secrets, passwords or user JWTs are written to fixtures/logs.
const statusResult = await new Deno.Command('node_modules/.bin/supabase', {
  args: ['status', '--workdir', 'tests/fixtures/local', '--output', 'json'],
  stdout: 'piped',
  stderr: 'piped',
}).output();
assert.equal(statusResult.code, 0, 'Start the dedicated local Supabase fixture first');
const status = JSON.parse(new TextDecoder().decode(statusResult.stdout));
const base: string = status.API_URL;
const key: string = status.PUBLISHABLE_KEY;
assert.equal(base, 'http://127.0.0.1:55431', 'Integration tests refuse a non-fixture destination');
assert.ok(key.startsWith('sb_publishable_'));
type Session = { access_token: string; user: { id: string; is_anonymous: boolean } };
const board = `http-${crypto.randomUUID()}`;
const off = `${board}-off`;
const users: string[] = [];
async function signIn(anonymous: boolean): Promise<Session> {
  const response = await fetch(`${base}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify(
      anonymous ? {} : {
        email: `http-${crypto.randomUUID()}@example.invalid`,
        password: `${crypto.randomUUID()}aA1!`,
      },
    ),
  });
  assert.equal(response.status, 200, 'Local Supabase Auth sign-up succeeds');
  const session = await response.json() as Session;
  assert.match(session.user.id, /^[0-9a-f-]{36}$/);
  users.push(session.user.id);
  assert.equal(session.user.is_anonymous, anonymous);
  return session;
}
async function api(
  path: string,
  options: {
    jwt?: string;
    method?: string;
    body?: unknown;
    apikey?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return await fetch(`${base}/functions/v1/supagame/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      apikey: options.apikey ?? key,
      ...(options.jwt ? { authorization: `Bearer ${options.jwt}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
async function success(response: Response, schema: string) {
  assert.equal(response.status, 200);
  const value = await response.json();
  assertSchema(schema, value);
  return value;
}
async function denied(response: Response, status: number, code?: string) {
  assert.equal(response.status, status);
  const value = await response.json();
  // Kong rejects invalid project keys before this function; its envelope is
  // platform-owned. Application errors must all use our OpenAPI ApiError.
  if (code) {
    assertSchema('ApiError', value);
    assert.equal(value.code, code);
  }
}

Deno.test('local Supabase Edge/Auth/PostgREST/RLS integration', async (t) => {
  query(
    `insert into public.game_leaderboards(id,kind,sort_direction,min_value,max_value,enabled) values
    ('${board}','points','desc',0,100,true),('${off}','points','desc',0,100,false)`,
  );
  try {
    const anonymous = await signIn(true);
    const permanent = await signIn(false);
    const submissionKey = crypto.randomUUID();
    await t.step('browser CORS preflight needs neither project key nor user JWT', async () => {
      const response = await fetch(`${base}/functions/v1/supagame/v1/players/me`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'apikey, authorization, content-type',
        },
      });
      // Local Kong owns OPTIONS and emits its generic preflight before Edge.
      // Unit tests separately check the handler's stricter 204 preflight.
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      await response.body?.cancel();
      const allowed = await api('/leaderboards', { headers: { origin: 'http://localhost:3000' } });
      assert.equal(allowed.status, 200);
      await allowed.body?.cancel();
      await denied(
        await api('/leaderboards', { headers: { origin: 'https://untrusted.example' } }),
        403,
        'FORBIDDEN',
      );
    });
    await t.step('public listing without a player JWT', async () => {
      const response = await api('/leaderboards');
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert.ok(Array.isArray(rows));
      for (const row of rows) assertSchema('LeaderboardSummary', row);
      assert.ok(rows.some((row) => row.id === board));
      assert.ok(!rows.some((row) => row.id === off));
    });
    await t.step('missing and invalid project keys rejected by local gateway', async () => {
      await denied(await api('/leaderboards', { apikey: '' }), 401);
      await denied(await api('/leaderboards', { apikey: 'sb_publishable_wrong' }), 401);
    });
    await t.step('protected route verifies the real Auth JWT', async () => {
      await denied(await api('/players/me'), 401, 'UNAUTHORIZED');
      await denied(await api('/players/me', { jwt: 'bad-token' }), 401, 'UNAUTHORIZED');
      const profile = await success(
        await api('/players/me', { jwt: anonymous.access_token }),
        'PlayerProfile',
      );
      assert.equal(profile.playerId, anonymous.user.id);
      const linked = await success(
        await api('/players/me', { jwt: permanent.access_token }),
        'PlayerProfile',
      );
      assert.equal(linked.playerId, permanent.user.id);
    });
    await t.step('profile updates validate names through SQL', async () => {
      const profile = await success(
        await api('/players/me', {
          method: 'PATCH',
          jwt: anonymous.access_token,
          body: { displayName: '  Local Player  ' },
        }),
        'PlayerProfile',
      );
      assert.equal(profile.displayName, 'Local Player');
      await denied(
        await api('/players/me', {
          method: 'PATCH',
          jwt: anonymous.access_token,
          body: { displayName: 'x' },
        }),
        400,
        'INVALID_DISPLAY_NAME',
      );
    });
    await t.step('first score, idempotent retry and conflicting key', async () => {
      const options = {
        method: 'POST',
        jwt: anonymous.access_token,
        body: { score: 10, submissionKey },
      };
      const first = await success(
        await api(`/leaderboards/${board}/scores`, options),
        'SubmitScoreResult',
      );
      assert.deepEqual(first, { outcome: 'best', score: 10, bestScore: 10 });
      assert.deepEqual(
        await success(await api(`/leaderboards/${board}/scores`, options), 'SubmitScoreResult'),
        first,
      );
      await denied(
        await api(`/leaderboards/${board}/scores`, {
          ...options,
          body: { score: 11, submissionKey },
        }),
        409,
        'DUPLICATE_KEY_CONFLICT',
      );
    });
    await t.step(
      'cross-user payload rejected; permanent account retains its own identity',
      async () => {
        await denied(
          await api(`/leaderboards/${board}/scores`, {
            method: 'POST',
            jwt: anonymous.access_token,
            body: { score: 99, submissionKey: crypto.randomUUID(), playerId: permanent.user.id },
          }),
          400,
          'INVALID_REQUEST',
        );
        const empty = await api(`/leaderboards/${board}/me`, { jwt: permanent.access_token });
        assert.equal(empty.status, 200);
        assert.equal(await empty.json(), null);
        await success(
          await api(`/leaderboards/${board}/scores`, {
            method: 'POST',
            jwt: permanent.access_token,
            body: { score: 20, submissionKey: crypto.randomUUID() },
          }),
          'SubmitScoreResult',
        );
        const mine = await success(
          await api(`/leaderboards/${board}/me`, { jwt: anonymous.access_token }),
          'MyScore',
        );
        assert.equal(mine.playerId, anonymous.user.id);
        assert.equal(mine.rank, 2);
      },
    );
    await t.step('raw HTTP pagination retains its cursor and ranks', async () => {
      const first = await success(
        await api(`/leaderboards/${board}/entries?limit=1`),
        'LeaderboardPage',
      );
      assert.equal(first.entries[0].playerId, permanent.user.id);
      const second = await success(
        await api(
          `/leaderboards/${board}/entries?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        ),
        'LeaderboardPage',
      );
      assert.equal(second.entries[0].playerId, anonymous.user.id);
      assert.equal(second.entries[0].rank, 2);
      assert.equal(second.nextCursor, null);
      await denied(
        await api(`/leaderboards/${board}/entries?cursor=%7B%7D`),
        400,
        'INVALID_CURSOR',
      );
    });
    await t.step('SQL validation and disabled/missing boards map to HTTP errors', async () => {
      await denied(
        await api(`/leaderboards/${board}/scores`, {
          method: 'POST',
          jwt: anonymous.access_token,
          body: { score: 101, submissionKey: crypto.randomUUID() },
        }),
        400,
        'INVALID_SCORE',
      );
      await denied(await api(`/leaderboards/${off}/entries`), 404, 'LEADERBOARD_NOT_FOUND');
      await denied(
        await api(`/leaderboards/${board}-missing/entries`),
        404,
        'LEADERBOARD_NOT_FOUND',
      );
    });
    await t.step('database throttling is enforced through HTTP and retries stay free', async () => {
      for (let i = 0; i < 9; i++) {
        await success(
          await api(`/leaderboards/${board}/scores`, {
            method: 'POST',
            jwt: anonymous.access_token,
            body: { score: 5, submissionKey: crypto.randomUUID() },
          }),
          'SubmitScoreResult',
        );
      }
      await denied(
        await api(`/leaderboards/${board}/scores`, {
          method: 'POST',
          jwt: anonymous.access_token,
          body: { score: 30, submissionKey: crypto.randomUUID() },
        }),
        429,
        'RATE_LIMITED',
      );
      await success(
        await api(`/leaderboards/${board}/scores`, {
          method: 'POST',
          jwt: anonymous.access_token,
          body: { score: 10, submissionKey },
        }),
        'SubmitScoreResult',
      );
    });
    await t.step('REST table writes/private columns remain denied for both API roles', async () => {
      for (const jwt of [undefined, anonymous.access_token]) {
        const headers = {
          apikey: key,
          ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
          'content-type': 'application/json',
        };
        for (const method of ['POST', 'PATCH', 'DELETE']) {
          const response = await fetch(
            `${base}/rest/v1/game_best_scores?leaderboard_id=eq.${board}`,
            {
              method,
              headers,
              ...(method === 'DELETE' ? {} : { body: JSON.stringify({ score: 99 }) }),
            },
          );
          assert.ok([401, 403].includes(response.status), 'Direct writes denied');
          await response.body?.cancel();
        }
        const response = await fetch(`${base}/rest/v1/game_players?select=hidden`, { headers });
        assert.ok([401, 403].includes(response.status));
        await response.body?.cancel();
        const events: Response = await fetch(`${base}/rest/v1/game_submission_events`, { headers });
        assert.equal(events.status, 404);
        await events.body?.cancel();
      }
    });
    await t.step('hidden entries stay hidden through public Edge reads', async () => {
      query(`update public.game_players set hidden=true where user_id='${permanent.user.id}'`);
      const page = await success(await api(`/leaderboards/${board}/entries`), 'LeaderboardPage');
      assert.equal(page.entries.length, 1);
      assert.equal(page.entries[0].playerId, anonymous.user.id);
      assert.equal(page.entries[0].rank, 1);
      const mine = await api(`/leaderboards/${board}/me`, { jwt: permanent.access_token });
      assert.equal(await mine.json(), null);
    });
  } finally {
    for (const id of users) query(`delete from auth.users where id='${id}'`);
    query(`delete from public.game_leaderboards where id in ('${board}','${off}')`);
  }
});

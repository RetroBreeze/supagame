import assert from 'node:assert/strict';
import { createApi } from '../../modules/leaderboards/functions/supagame/routes.ts';
import { assertSchema } from './http-schema.ts';

// Signing material exists only in memory; these are not project credentials.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const publicKey = {
  ...await crypto.subtle.exportKey('jwk', pair.publicKey),
  kid: crypto.randomUUID(),
  alg: 'ES256',
  use: 'sig',
};
const key = `sb_publishable_${crypto.randomUUID().replaceAll('-', '')}`;
const userId = '60000000-0000-4000-8000-000000000001';
const submissionKey = '60000000-0000-4000-8000-000000000002';
const issuer = 'https://project.example/auth/v1';
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function token(overrides: Record<string, unknown> = {}, signingKey = pair.privateKey) {
  const text = new TextEncoder();
  const header = encode(text.encode(JSON.stringify({ alg: 'ES256', kid: publicKey.kid })));
  const body = encode(
    text.encode(
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) + 300,
        is_anonymous: true,
        ...overrides,
      }),
    ),
  );
  return `${header}.${body}.${
    encode(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signingKey,
          text.encode(`${header}.${body}`),
        ),
      ),
    )
  }`;
}
const validToken = await token();
const profile = { playerId: userId, displayName: null, createdAt: '2026-01-01T00:00:00Z' };
const board = {
  id: 'arcade',
  kind: 'points',
  sortDirection: 'desc',
  minValue: null,
  maxValue: 100,
};
const entry = {
  playerId: userId,
  displayName: null,
  score: 10,
  rank: 1,
  achievedAt: profile.createdAt,
};
const responses: Record<string, unknown> = {
  sg_list_leaderboards: [board],
  sg_get_entries: { entries: [entry], nextCursor: null },
  sg_get_my_score: entry,
  sg_submit_score: { outcome: 'best', score: 10, bestScore: 10 },
  sg_get_my_profile: profile,
  sg_update_my_profile: { ...profile, displayName: 'Player' },
};
function fixture(result?: { status: number; body: unknown }) {
  const calls: {
    name: string;
    args: unknown;
    authorization: string | null;
    apikey: string | null;
  }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const name = new URL(req.url).pathname.split('/').at(-1)!;
    calls.push({
      name,
      args: await req.json(),
      authorization: req.headers.get('authorization'),
      apikey: req.headers.get('apikey'),
    });
    return Response.json(result ? result.body : responses[name], { status: result?.status ?? 200 });
  };
  const handle = createApi({
    env: {
      url: 'https://project.example',
      publishableKeys: { default: key },
      secretKeys: {},
      jwks: { keys: [publicKey] },
    },
    issuer,
    allowedOrigins: ['https://game.example'],
  }, fetcher);
  return { handle, calls };
}
function request(
  path: string,
  options: {
    method?: string;
    body?: string;
    jwt?: string | null;
    apikey?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(options.headers);
  if (options.apikey !== null) headers.set('apikey', options.apikey ?? key);
  if (options.jwt !== null) headers.set('authorization', `Bearer ${options.jwt ?? validToken}`);
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`https://project.example/functions/v1/supagame/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const text = await response.text();
  assert.ok(
    !text.includes(validToken) && !text.includes(key) && !text.includes('private database detail'),
  );
  const body = JSON.parse(text);
  assertSchema('ApiError', body);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, 'string');
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

for (
  const route of [
    { path: '/leaderboards', name: 'sg_list_leaderboards', args: {}, public: true },
    {
      path: '/leaderboards/arcade/entries?limit=2',
      name: 'sg_get_entries',
      args: { p_board_id: 'arcade', p_limit: 2, p_cursor: null },
      public: true,
    },
    { path: '/leaderboards/arcade/me', name: 'sg_get_my_score', args: { p_board_id: 'arcade' } },
    {
      path: '/leaderboards/arcade/scores',
      method: 'POST',
      body: { score: 10, submissionKey },
      name: 'sg_submit_score',
      args: { p_board_id: 'arcade', p_score: 10, p_submission_key: submissionKey },
    },
    { path: '/players/me', name: 'sg_get_my_profile', args: {} },
    {
      path: '/players/me',
      method: 'PATCH',
      body: { displayName: 'Player' },
      name: 'sg_update_my_profile',
      args: { p_display_name: 'Player' },
    },
  ]
) {
  Deno.test(`${route.method ?? 'GET'} ${route.path}: exact RPC and response`, async () => {
    const f = fixture();
    const response = await f.handle(request(route.path, {
      ...(route.method ? { method: route.method } : {}),
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      ...(route.public ? { jwt: null } : {}),
    }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data, responses[route.name]);
    const schemas: Record<string, string> = {
      sg_list_leaderboards: 'LeaderboardSummary',
      sg_get_entries: 'LeaderboardPage',
      sg_get_my_score: 'MyScore',
      sg_submit_score: 'SubmitScoreResult',
      sg_get_my_profile: 'PlayerProfile',
      sg_update_my_profile: 'PlayerProfile',
    };
    if (route.name === 'sg_list_leaderboards') {
      assert.ok(Array.isArray(data));
      for (const value of data) assertSchema('LeaderboardSummary', value);
    } else assertSchema(schemas[route.name]!, data);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.name, route.name);
    assert.deepEqual(f.calls[0]?.args, route.args);
    assert.ok(f.calls[0]?.apikey === key);
    assert.ok(f.calls[0]?.authorization === `Bearer ${route.public ? key : validToken}`);
  });
}

Deno.test('public routes ignore optional JWTs and remain anon-scoped', async () => {
  const f = fixture();
  assert.equal((await f.handle(request('/leaderboards', { jwt: 'malformed' }))).status, 200);
  assert.ok(f.calls[0]?.authorization === `Bearer ${key}`);
});
for (const apikey of [null, '', 'sb_publishable_wrong', 'sb_secret_not-a-client-key']) {
  Deno.test(`invalid project key rejected (${apikey === null ? 'missing' : apikey === '' ? 'empty' : 'wrong type/value'})`, async () => {
    const f = fixture();
    await error(await f.handle(request('/leaderboards', { apikey })), 401, 'UNAUTHORIZED');
    await error(await f.handle(request('/players/me', { apikey })), 401, 'UNAUTHORIZED');
    assert.equal(f.calls.length, 0);
  });
}
for (
  const [label, jwt] of [
    ['missing', null],
    ['malformed', 'bad'],
    ['expired', await token({ exp: 1 })],
    ['no expiry', await token({ exp: undefined })],
    ['wrong role', await token({ role: 'service_role' })],
    ['no subject', await token({ sub: undefined })],
    ['wrong audience', await token({ aud: 'other' })],
    ['wrong issuer', await token({ iss: 'https://other.example/auth/v1' })],
    ['future token', await token({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    [
      'wrong signature',
      await token(
        {},
        (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ])).privateKey,
      ),
    ],
  ] as const
) {
  Deno.test(`protected routes reject ${label} JWT`, async () => {
    const f = fixture();
    for (
      const [path, method, body] of [
        ['/players/me', 'GET', undefined],
        ['/players/me', 'PATCH', '{"displayName":"Player"}'],
        ['/leaderboards/arcade/me', 'GET', undefined],
        ['/leaderboards/arcade/scores', 'POST', JSON.stringify({ score: 10, submissionKey })],
      ] as const
    ) {
      await error(
        await f.handle(request(path, { method, jwt, ...(body ? { body } : {}) })),
        401,
        'UNAUTHORIZED',
      );
    }
    assert.equal(f.calls.length, 0);
  });
}
Deno.test('permanent user JWT is accepted', async () => {
  const f = fixture();
  assert.equal(
    (await f.handle(request('/players/me', { jwt: await token({ is_anonymous: false }) }))).status,
    200,
  );
});

for (
  const [label, body, code] of [
    ['invalid JSON', '{', 'INVALID_REQUEST'],
    ['array', '[]', 'INVALID_REQUEST'],
    ['null', 'null', 'INVALID_REQUEST'],
    ['missing score', JSON.stringify({ submissionKey }), 'INVALID_REQUEST'],
    [
      'forged user',
      JSON.stringify({ score: 10, submissionKey, userId: userId }),
      'INVALID_REQUEST',
    ],
    [
      'forged player',
      JSON.stringify({ score: 10, submissionKey, playerId: userId }),
      'INVALID_REQUEST',
    ],
    ['string score', JSON.stringify({ score: '10', submissionKey }), 'INVALID_SCORE'],
    ['fraction', JSON.stringify({ score: 1.5, submissionKey }), 'INVALID_SCORE'],
    ['unsafe integer', JSON.stringify({ score: 9007199254740992, submissionKey }), 'INVALID_SCORE'],
    [
      'rounded fraction',
      `{"score":9007199254740990.5,"submissionKey":"${submissionKey}"}`,
      'INVALID_SCORE',
    ],
    [
      'rounded decimal',
      `{"score":1.0000000000000001,"submissionKey":"${submissionKey}"}`,
      'INVALID_SCORE',
    ],
    ['underflow', `{"score":1e-999,"submissionKey":"${submissionKey}"}`, 'INVALID_SCORE'],
    ['overflow', `{"score":1e999,"submissionKey":"${submissionKey}"}`, 'INVALID_SCORE'],
    ['bad UUID', '{"score":10,"submissionKey":"bad"}', 'INVALID_REQUEST'],
  ] as const
) {
  Deno.test(`score request rejects ${label}`, async () => {
    const f = fixture();
    await error(
      await f.handle(request('/leaderboards/arcade/scores', { method: 'POST', body })),
      400,
      code,
    );
    assert.equal(f.calls.length, 0);
  });
}
for (
  const body of [
    '{"displayName":null}',
    '{"displayName":1}',
    '{"displayName":"abc","hidden":false}',
    '{"displayName":"abc","userId":"other"}',
  ]
) {
  Deno.test('profile request requires only a string displayName', async () => {
    const f = fixture();
    await error(
      await f.handle(request('/players/me', { method: 'PATCH', body })),
      400,
      'INVALID_REQUEST',
    );
    assert.equal(f.calls.length, 0);
  });
}
Deno.test('display-name business validation remains in SQL', async () => {
  const f = fixture({ status: 400, body: { code: '22023', message: 'INVALID_DISPLAY_NAME' } });
  await error(
    await f.handle(request('/players/me', { method: 'PATCH', body: '{"displayName":" x "}' })),
    400,
    'INVALID_DISPLAY_NAME',
  );
  assert.deepEqual(f.calls[0]?.args, { p_display_name: ' x ' });
});
Deno.test('requires JSON content type and rejects content encoding', async () => {
  const f = fixture();
  await error(
    await f.handle(
      request('/players/me', {
        method: 'PATCH',
        body: '{}',
        headers: { 'content-type': 'text/plain' },
      }),
    ),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  await error(
    await f.handle(
      request('/players/me', {
        method: 'PATCH',
        body: '{}',
        headers: { 'content-encoding': 'gzip' },
      }),
    ),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  assert.equal(f.calls.length, 0);
});
Deno.test('body limit counts actual UTF-8 bytes, including streams without length', async () => {
  const f = fixture();
  await error(
    await f.handle(
      request('/players/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: '猫'.repeat(1400) }),
      }),
    ),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  await error(
    await f.handle(
      request('/players/me', {
        method: 'PATCH',
        body: '{}',
        headers: { 'content-length': '4097' },
      }),
    ),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(2048).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request(request('/players/me', { method: 'PATCH', body: '{}' }), {
    body: stream,
  });
  await error(await f.handle(streamed), 413, 'PAYLOAD_TOO_LARGE');
  assert.ok(cancelled);
  assert.equal(f.calls.length, 0);
});
Deno.test('exactly 4096 bytes is allowed', async () => {
  const f = fixture();
  const body = '{"displayName":"Player"}';
  assert.equal(
    (await f.handle(
      request('/players/me', { method: 'PATCH', body: body + ' '.repeat(4096 - body.length) }),
    )).status,
    200,
  );
});
Deno.test('exact integer exponent notation remains valid', async () => {
  const f = fixture();
  assert.equal(
    (await f.handle(
      request('/leaderboards/arcade/scores', {
        method: 'POST',
        body: `{"score":1.20e2,"submissionKey":"${submissionKey}"}`,
      }),
    )).status,
    200,
  );
  assert.deepEqual(f.calls[0]?.args, {
    p_board_id: 'arcade',
    p_score: 120,
    p_submission_key: submissionKey,
  });
});
for (
  const query of [
    'limit=0',
    'limit=101',
    'limit=-1',
    'limit=1.5',
    'limit=1e1',
    'limit=',
    'limit=1&limit=2',
    'userId=other',
    'cursor=',
    'cursor=null',
    'cursor=%7B',
    'cursor=%5B%5D',
    'cursor=%22text%22',
    'cursor=%7B%7D&cursor=%7B%7D',
  ]
) {
  Deno.test(`invalid pagination ${query}`, async () => {
    const f = fixture();
    await error(
      await f.handle(request(`/leaderboards/arcade/entries?${query}`)),
      400,
      query.startsWith('cursor=') ? 'INVALID_CURSOR' : 'INVALID_REQUEST',
    );
    assert.equal(f.calls.length, 0);
  });
}
Deno.test('cursor stays opaque on output and is decoded without losing timestamp precision', async () => {
  const cursor = {
    boardId: 'arcade',
    score: 10,
    achievedAt: '2026-01-01T00:00:00.123456Z',
    playerId: userId,
  };
  const f = fixture();
  assert.equal(
    (await f.handle(
      request('/leaderboards/arcade/entries?cursor=' + encodeURIComponent(JSON.stringify(cursor))),
    )).status,
    200,
  );
  assert.deepEqual(f.calls[0]?.args, { p_board_id: 'arcade', p_limit: 50, p_cursor: cursor });
});
for (
  const [sqlCode, message, status, code] of [
    ['P0002', 'LEADERBOARD_NOT_FOUND', 404, 'LEADERBOARD_NOT_FOUND'],
    ['23505', 'DUPLICATE_KEY_CONFLICT', 409, 'DUPLICATE_KEY_CONFLICT'],
    ['22023', 'INVALID_SCORE', 400, 'INVALID_SCORE'],
    ['22023', 'INVALID_CURSOR', 400, 'INVALID_CURSOR'],
    ['P0001', 'RATE_LIMITED', 429, 'RATE_LIMITED'],
    ['28000', 'UNAUTHORIZED', 401, 'UNAUTHORIZED'],
    ['42501', 'private database detail', 403, 'FORBIDDEN'],
    ['PGRST301', 'private database detail', 401, 'UNAUTHORIZED'],
    ['XX000', 'private database detail', 500, 'INTERNAL_ERROR'],
    ['XX000', 'RATE_LIMITED', 500, 'INTERNAL_ERROR'],
  ] as const
) {
  Deno.test(`SQL mapping ${sqlCode}/${code}`, async () => {
    const f = fixture({
      status: 400,
      body: {
        code: sqlCode,
        message,
        details: 'private database detail',
        hint: 'private database detail',
      },
    });
    await error(await f.handle(request('/leaderboards/arcade/me')), status, code);
  });
}
Deno.test('null personal score remains JSON null', async () => {
  const f = fixture({ status: 200, body: null });
  const response = await f.handle(request('/leaderboards/arcade/me'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'null');
});
Deno.test('CORS preflight succeeds without credentials and never calls the database', async () => {
  const f = fixture();
  const response = await f.handle(
    request('/players/me', {
      method: 'OPTIONS',
      apikey: null,
      jwt: null,
      headers: {
        origin: 'https://game.example',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type, apikey, authorization',
      },
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://game.example');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  assert.equal(f.calls.length, 0);
});
Deno.test('CORS applies to successes and errors; disallowed origins and headers fail closed', async () => {
  const f = fixture();
  const allowed = await f.handle(
    request('/players/me', { jwt: null, headers: { origin: 'https://game.example' } }),
  );
  assert.equal(allowed.status, 401);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://game.example');
  await allowed.body?.cancel();
  const denied = await f.handle(
    request('/leaderboards', { headers: { origin: 'https://evil.example' } }),
  );
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  await error(denied, 403, 'FORBIDDEN');
  await error(
    await f.handle(
      request('/players/me', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://game.example',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'x-admin',
        },
      }),
    ),
    403,
    'FORBIDDEN',
  );
  assert.equal(f.calls.length, 0);
});
Deno.test('unknown paths and unsupported methods do not dispatch RPCs', async () => {
  const f = fixture();
  await error(await f.handle(request('/missing')), 404, 'NOT_FOUND');
  const response = await f.handle(request('/players/me', { method: 'DELETE' }));
  assert.match(response.headers.get('allow') ?? '', /GET/);
  await error(response, 405, 'METHOD_NOT_ALLOWED');
  await error(await f.handle(request('/leaderboards/%ZZ/entries')), 400, 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
});
Deno.test('transport exceptions cannot leak internals', async () => {
  const handle = createApi({
    env: {
      url: 'https://project.example',
      publishableKeys: { default: key },
      secretKeys: {},
      jwks: { keys: [publicKey] },
    },
    issuer,
    allowedOrigins: [],
  }, () => {
    throw new Error('private database detail');
  });
  await error(await handle(request('/players/me')), 500, 'INTERNAL_ERROR');
});

for (const displayName of ['bad\u0000name', 'bad\ud800name']) {
  Deno.test('profile rejects strings PostgreSQL cannot represent', async () => {
    const f = fixture();
    await error(
      await f.handle(request('/players/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      })),
      400,
      'INVALID_DISPLAY_NAME',
    );
    assert.equal(f.calls.length, 0);
  });
}
Deno.test('cursor rejects invalid Unicode before PostgREST JSONB decoding', async () => {
  const f = fixture();
  const cursor = JSON.stringify({ boardId: 'bad\u0000board' });
  await error(
    await f.handle(request(`/leaderboards/arcade/entries?cursor=${encodeURIComponent(cursor)}`)),
    400,
    'INVALID_CURSOR',
  );
  assert.equal(f.calls.length, 0);
});

Deno.test('malformed quoted charset is rejected', async () => {
  const f = fixture();
  for (const type of ['application/json; charset="utf-8', 'application/json; charset=utf-8"']) {
    await error(
      await f.handle(request('/players/me', {
        method: 'PATCH',
        body: '{"displayName":"Player"}',
        headers: { 'content-type': type },
      })),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
  assert.equal(f.calls.length, 0);
});
Deno.test('cursor rejects unrepresentable JSON property names', async () => {
  const f = fixture();
  for (const key of ['\u0000', '\ud800']) {
    const cursor = JSON.stringify({ [key]: 1 });
    await error(
      await f.handle(request(`/leaderboards/arcade/entries?cursor=${encodeURIComponent(cursor)}`)),
      400,
      'INVALID_CURSOR',
    );
  }
  assert.equal(f.calls.length, 0);
});

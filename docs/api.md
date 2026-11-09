# API and TypeScript reference

The [OpenAPI 3.1 contract](../packages/contracts/openapi.yaml) is authoritative.
Base URL: `https://<project-ref>.supabase.co/functions/v1/supagame/v1`, or the
same path under your local API URL. Requests and responses use JSON.

Every application request needs `apikey: <project publishable key>`. Protected
routes also need `Authorization: Bearer <Supabase Auth user access token>`.
Anonymous Supabase **users** are authenticated users; the database `anon` role
means a request without a player session. Never send a service-role/secret key.

| Method and path | Player JWT | Result |
| --- | --- | --- |
| `GET /leaderboards` | Optional | Enabled board summaries |
| `GET /leaderboards/:id/entries?limit=50&cursor=...` | Optional | `{ entries, nextCursor }` |
| `GET /leaderboards/:id/me` | Required | Visible personal best entry or `null` |
| `POST /leaderboards/:id/scores` | Required | `{ outcome, score, bestScore }` |
| `GET /players/me` | Required | Creates/retrieves the caller's profile |
| `PATCH /players/me` | Required | Updates the caller's display name |

A summary contains `id`, `kind` (`time` or `points`), `sortDirection` (`asc` or
`desc`), and nullable inclusive `minValue`/`maxValue`. A profile contains only
`playerId`, nullable `displayName`, and `createdAt`. An entry contains `playerId`,
nullable `displayName`, safe-integer `score`, competition `rank`, and `achievedAt`.
Timestamps are server-generated ISO date-time strings. Keep their precision.
Hidden players and disabled boards are excluded from public results. A hidden
player's own standing is `null`, while their private profile remains accessible.

## Scores and idempotency

Submit exactly `{ "score": 42500, "submissionKey": "<UUID>" }`. All languages must
respect the JSON safe-integer range **−9007199254740991 to 9007199254740991**, as
well as board bounds. Floating point values, quoted numbers, unknown body fields,
client-supplied player IDs, and oversized bodies are rejected. Max body: 4096 UTF-8
bytes. Send uncompressed `application/json` using UTF-8.

`best` establishes a new personal best; `not_best` accepts an equal/worse score
without changing the original best timestamp. Only one best is retained per
player/board. An ascending board keeps the smallest score; descending keeps the
largest. `kind` is metadata, not a conversion of units or scoring rules.

Keys are scoped to player + board. Retry the same key and score to receive the
**original** result, even after a subsequent better score or changed board state.
A different score for that key returns `DUPLICATE_KEY_CONFLICT`. New valid attempts,
including equal/worse scores, count toward **10 submissions per player per board
in a rolling 60 seconds**. Replays spend no additional quota; invalid attempts do
not create events. Concurrent updates, replays and quota checks serialize in SQL.

## Rankings and pagination

`limit` defaults to 50 and must be 1–100. Equal scores share competition rank:
`1, 1, 3`. Display order is score in board direction, then achievement timestamp
ascending, then player UUID ascending. Ranks are calculated among visible players.

Pass `nextCursor` unchanged as the URL-encoded `cursor` query parameter; omit it on
the first page. `null` means the end. Cursors identify the board and preserve the
last score/timestamp/player tuple. Do not decode and reconstruct them through a
JavaScript `Date`, which loses PostgreSQL microseconds. Malformed cursors and
cross-board cursors fail. Pages are deterministic for unchanged data, **not a
snapshot** across concurrent score changes; refresh from the first page after
updates. Unknown/repeated query parameters are rejected.

## Raw HTTP example

This uses only a publishable key and the current user's access token:

```ts
const api = `${projectUrl}/functions/v1/supagame/v1`;
const headers = { apikey: publishableKey };
const publicPage = await fetch(`${api}/leaderboards/level-1/entries?limit=10`, { headers });
const session = (await supabase.auth.getSession()).data.session;
if (!session) throw new Error('Sign in first');
const result = await fetch(`${api}/leaderboards/level-1/scores`, {
  method: 'POST',
  headers: { ...headers, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ score: 42500, submissionKey: crypto.randomUUID() }),
});
if (!result.ok) {
  // Application errors have { code, message }; gateway failures may use another envelope.
  throw new Error(`Score request failed (${result.status})`);
}
const submitted = await result.json();
```

## Errors

Application failures are `{ "code": "STABLE_IDENTIFIER", "message": "Public explanation" }`.
Never parse message text to select game behavior. Gateways can produce different
bodies, so handle status and malformed JSON defensively in non-SDK clients.

| HTTP status | Identifiers |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_SCORE`, `INVALID_CURSOR`, `INVALID_DISPLAY_NAME` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` (origin or database permission) |
| 404 | `LEADERBOARD_NOT_FOUND` (missing or disabled), `NOT_FOUND` (route) |
| 405 | `METHOD_NOT_ALLOWED`, with `Allow` header |
| 409 | `DUPLICATE_KEY_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

Successful application calls return 200. CORS preflight requires no credentials;
Edge returns 204, but the Supabase gateway can answer with 200 and broader headers.
Actual browser requests still enforce the exact configured origin allowlist.
CORS is not authentication. Responses are `no-store`; SQL details and stack traces
are not returned by the Edge application.

## SDK surface

`createGameServices({ supabase, baseUrl?, publishableKey? })` takes the existing
caller-owned Supabase client. The optional key is required only when overriding
the full API base URL; otherwise the client's public Functions transport supplies
its key and URL. The SDK does not read protected client fields.

- `players.ensureAnonymousSession(): Promise<{ userId: string }>`
- `players.getMe(): Promise<PlayerProfile>`
- `players.updateMe({ displayName }): Promise<PlayerProfile>` — trims 3–24 printable characters
- `leaderboards.getTop(id, { limit?, cursor? }?): Promise<LeaderboardPage>`
- `leaderboards.getMine(id): Promise<MyScore | null>`
- `leaderboards.submit(id, score, submissionKey?): Promise<SubmitScoreResult>`

DTOs come from the contract package. For full declaration checking with the pinned
Supabase peer, install `typescript@5.9.3` and `@types/node@24.19.2` as development
dependencies: upstream storage/transport declarations reference Node types even in
browser projects. This does not require Node runtime polyfills.

 The list-boards endpoint is available through
raw HTTP; there is no SDK list method in v0.1. The SDK retries one network failure
on submission with the same key and identity; it does not automatically retry HTTP
errors, profile operations or anonymous sign-in. Failures after submission begins
carry `GameServicesError.submissionKey` for deliberate retries. For persistence
across reloads, save an explicit key with the attempt before sending it.

```ts
import { ApiError, AuthenticationError, GameServicesError } from '@supagame/sdk-ts';
try {
  await game.leaderboards.submit('arcade', 1200, savedSubmissionKey);
} catch (error) {
  if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
    // Wait before retrying; use the same key for this attempt.
  } else if (error instanceof AuthenticationError) {
    // Recover authentication with the caller's Supabase client. Do not silently replace identity.
  } else if (error instanceof GameServicesError) {
    // Show error.message. Network/format failures may have an uncertain submission outcome.
  } else {
    throw error;
  }
}
```

Other typed errors: `NetworkError`, `InvalidParameterError`, `UnexpectedResponseError`.
See the [SDK README](../packages/sdk-ts/README.md) for browser/runtime details.

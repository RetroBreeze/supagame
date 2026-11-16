# @retrobreeze/supagame-sdk

The TypeScript client for Supagame. Use it with your existing Supabase client
in JavaScript or TypeScript games. Set up the backend with the
[quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart) first.

## Install

```sh
npm install @retrobreeze/supagame-sdk @supabase/supabase-js@2.119.0
```

TypeScript projects also need Node declarations for Supabase's types, including
browser projects:

```sh
npm install -D @types/node@24.19.2
```

If `compilerOptions.types` is restricted,
include `node`. This adds no browser runtime polyfills. Node.js consumers use 24 or 26.
The contracts package is installed automatically.

## Submit and read scores

Use the URL and publishable key from `npx supagame connection`. If your application
already has a Supabase client, reuse it.

```ts
import { createClient } from '@supabase/supabase-js';
import { createGameServices } from '@retrobreeze/supagame-sdk';

const supabase = createClient(
  'https://YOUR_PROJECT_REF.supabase.co',
  'sb_publishable_YOUR_PROJECT_KEY',
);
const game = createGameServices({ supabase });

await game.players.ensureAnonymousSession();
await game.players.updateMe({ displayName: 'Player One' });
const result = await game.leaderboards.submit('arcade', 1250);
const top = await game.leaderboards.getTop('arcade', { limit: 10 });
const mine = await game.leaderboards.getMine('arcade');
console.log(result.bestScore, top.entries, mine);
```

Public reads need no player session. `ensureAnonymousSession()` reuses an existing
anonymous or permanent session and creates a guest only when none exists. Auth
failures do not silently replace the player. Supabase handles storage and refresh;
losing an unlinked guest's session can lose access to their data.

## Core methods

| Method | Result |
| --- | --- |
| `players.ensureAnonymousSession()` | `{ userId }` |
| `players.getMe()` | Player profile |
| `players.updateMe({ displayName })` | Updated profile; names are 3–24 printable characters |
| `leaderboards.submit(id, score, submissionKey?)` | `{ outcome, score, bestScore }` |
| `leaderboards.getTop(id, { limit?, cursor? })` | `{ entries, nextCursor }` |
| `leaderboards.getMine(id)` | Personal rank entry or `null` |

Scores must be safe integers. Page limits are 1–100, defaulting to 50.
Pass `nextCursor` unchanged to fetch another page. Ranks are calculated by the backend.

## Errors and retries


All SDK errors extend `GameServicesError`, have a `kind` discriminator and can be
narrowed with `instanceof`:

| Error | Meaning |
| --- | --- |
| `AuthenticationError` | Missing, expired/unrefreshable or rejected user session; HTTP 401 |
| `ApiError` | Valid public error envelope; exposes `status`, stable API `code`, and `message` |
| `NetworkError` | Request failed or its response was lost |
| `InvalidParameterError` | Invalid caller input; exposes `parameter` |
| `UnexpectedResponseError` | Invalid JSON, media type, status or response schema |

For example, `ApiError.code` preserves `RATE_LIMITED`, `INVALID_SCORE`,
`DUPLICATE_KEY_CONFLICT` and `LEADERBOARD_NOT_FOUND`. The wire error DTO is exported
as `ApiErrorBody` to distinguish it from the error class. Authentication and
transport exceptions use generic messages; underlying causes and credentials
are neither logged nor attached to SDK errors.

`submit()` generates a secure UUID if no key is supplied. It retries **one network
failure** with exactly the same body/key and the same player identity. HTTP errors
(including 429 and 5xx) and malformed responses are not retried automatically.
No other method is automatically retried by this SDK; Supabase retains its own
Auth refresh behavior.

A failure after submission begins carries `GameServicesError.submissionKey`.
Use it with the **same board, score and player** for a deliberate manual retry.
For retries across reloads, supply and persist your own key before submitting.
Do not call `submit()` again without a key to retry an uncertain outcome: that
starts a new submission attempt. The server returns the original result for an
idempotent retry, which may differ from a subsequently improved personal best.


## Other features

- [Live Leaderboards](https://github.com/RetroBreeze/supagame/wiki/Live-Leaderboards): subscriptions and rank-change events.
- [Achievements](https://github.com/RetroBreeze/supagame/wiki/Achievements): unlocks and notifications.
- [Cloud Saves](https://github.com/RetroBreeze/supagame/wiki/Cloud-Saves): JSON, binary and offline saves.
- [Accounts](https://github.com/RetroBreeze/supagame/wiki/Accounts): linking, sign-in and recovery.

Dispose subscriptions and notification queues when leaving a screen. Account flows
need a stable `accounts.namespace` and a persistence adapter; see the account guide.

## Custom API location

The default transport uses the Supabase client's project URL, key and custom fetch.
For a trusted custom location, supply the full API URL and project publishable key:

```ts
const game = createGameServices({
  supabase,
  baseUrl: 'https://game.example/functions/v1/supagame/v1',
  publishableKey: 'sb_publishable_YOUR_PROJECT_KEY',
});
```

Overrides use standard `fetch`, omit cookies and reject redirects. HTTPS is required
except on loopback. Protected requests send the player's JWT to this URL; use only
a trusted endpoint. Never put privileged credentials in a game client.

[HTTP API](https://github.com/RetroBreeze/supagame/wiki/API) ·
[Target Rush example](https://github.com/RetroBreeze/supagame/tree/main/examples/target-rush)

## Cloud Saves retries

Cloud Saves durable retries require `generation` alongside `operationId`.
Keep the original payload and context on `SAVE_CONFLICT`; resolve explicitly.
The guarantee covers the latest 3,072 completed operations that are also younger
than 30 days. See the [protocol guide](https://github.com/RetroBreeze/supagame/blob/main/docs/guides/cloud-save-protocol.md)
for SDK examples, uploads, offline queues and migration behavior.

For AI-assisted integration, the separate
[Supagame agent skill](https://github.com/RetroBreeze/supagame/wiki/Agent-Skill)
covers this SDK and HTTP clients for other engines. Install it in the consumer
repository; npm installation does not activate it.

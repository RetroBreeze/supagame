# @supagame/sdk-ts

Browser-compatible TypeScript wrappers for the Supagame v1 HTTP API. The caller
supplies a Supabase client initialized with the project's **publishable** key.
Never initialize a game client with a secret or service-role key.

The package is currently private in this repository; no npm publication is part
of this implementation. Build the workspace with `pnpm build`.

```ts
import { createGameServices } from '@supagame/sdk-ts';

// Reuse your application's existing Supabase client and storage adapter.
const game = createGameServices({ supabase });
const { userId } = await game.players.ensureAnonymousSession();
const profile = await game.players.getMe();
await game.players.updateMe({ displayName: 'Player One' });

const submissionKey = crypto.randomUUID();
const result = await game.leaderboards.submit('level-1', 42500, submissionKey);
const page = await game.leaderboards.getTop('level-1', { limit: 10 });
const mine = await game.leaderboards.getMine('level-1'); // null if no score
if (page.nextCursor !== null) {
  const nextPage = await game.leaderboards.getTop('level-1', {
    limit: 10,
    cursor: page.nextCursor,
  });
}
```

## Sessions and identity

Supabase owns storage, persistence, token refresh and account linking. The SDK
adds no storage, timers or auth-state subscriptions. Configure your caller-owned
client's storage for your application's environment as usual. The tested
peer dependency is `@supabase/supabase-js` 2.119.0; the peer range is `^2.119.0`.

`ensureAnonymousSession()` reuses both anonymous and permanent sessions, checks
an existing user with Supabase Auth, and signs in anonymously only when the
client reports no session and no authentication error. Simultaneous calls using
the same Auth client share one pending operation. A failed refresh or rejected
identity raises `AuthenticationError`; it never silently replaces that identity.
Independent clients/tabs remain subject to the caller's Supabase storage/locking
configuration; the SDK's in-flight coalescing operates within one JavaScript realm.

Only `ensureAnonymousSession()` initiates sign-in. Profile, personal score and
submission methods require an existing session. Public leaderboard reads do not
sign the player in. Each protected request reads the current session through
Supabase; an expired session is refreshed through that same client. The backend
still verifies the JWT and enforces authorization. Revocation follows Supabase
Auth/JWT validity rules; the SDK does not promise immediate access-token revocation.

If anonymous credentials are lost (for example, storage is cleared), their old
identity and scores cannot be recovered by this SDK. With no remaining session,
an explicit `ensureAnonymousSession()` creates a new identity. Preserve storage
or link the anonymous account through Supabase Auth before that happens.

## Transport and API compatibility

By default, the SDK uses the supplied client's public `functions.invoke` transport
for `supagame/v1/...`. That preserves the project URL, publishable key and custom
fetch configuration without reading protected client fields. The client may also
attach a current user JWT to public requests; the existing Edge public routes
continue to authorize using the publishable key.

For a trusted proxy or custom API location, supply the **full v1 API base** and
an explicit project publishable key:

```ts
const game = createGameServices({
  supabase,
  baseUrl: 'https://game.example/functions/v1/supagame/v1',
  publishableKey: 'sb_publishable_YOUR_PROJECT_KEY',
});
```

The optional `publishableKey` extension is required with `baseUrl` because the
Supabase client's project key is not a public getter. Overrides use the browser's
`fetch` with cookies omitted and redirects rejected. HTTPS is required except on
loopback for local testing. Choose only trusted URLs belonging to the intended
project: protected requests send the current user's JWT there. An override does
not inherit the Supabase client's custom fetch transport. The default transport
inherits the caller's redirect/network behavior.

DTOs are re-exported from `@supagame/contracts`; response and body validators are
generated from the same OpenAPI schemas. Validation rejects malformed responses,
unsafe score/rank integers, private extra fields and invalid formats. The SDK
leaves ordering, competition ranks, idempotency and all database business rules
to the API. Cursors stay opaque, preserving timestamp precision and tied entries.
Page size defaults to 50 and must be an integer from 1 to 100. Scores must be safe
integers. Display names are trimmed and checked against the API schema.

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

## Development and verification

```sh
pnpm --filter @supagame/sdk-ts test
pnpm --filter @supagame/sdk-ts typecheck
pnpm --filter @supagame/sdk-ts build
pnpm contracts:check
# Only the repository's isolated local Supabase fixture:
pnpm api:start
pnpm test:sdk:integration
pnpm db:stop
```

After an approved OpenAPI change, run
`pnpm --filter @supagame/sdk-ts validators:generate`. The committed standalone
validators require no Ajv, dynamic code generation or Node modules at runtime.
`pnpm contracts:check` checks their freshness along with generated DTOs. The
browser test bundles the SDK for a browser and executes it without Node globals
or eval. The standalone browser consumer is exercised in Chromium; native platforms
are optional and are not a v0.1 release requirement.

The runtime is ESM and uses standard Web APIs (Fetch, URL, Web Crypto). WebViews
without `crypto.randomUUID` use `crypto.getRandomValues`; if secure randomness is
unavailable, supply a UUID explicitly. The SDK does not import Supabase at runtime;
the host application owns that peer dependency. Tooling scripts are excluded from
the package's runtime file list.

MIT licensed, as specified in the repository's LICENSE.

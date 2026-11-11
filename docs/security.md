# Security model and v0.1 review

Supagame installs in a developer-owned Supabase project. The game client has only
the project URL, publishable key and its own Auth session. The CLI is a trusted
provisioning tool; it is never part of game runtime traffic.

This document records a source review and automated **local** security regressions,
not an independent audit, penetration test or hosted deployment certification.

## Reviewed boundaries

| Area | Implemented controls and evidence |
| --- | --- |
| Table access | RLS enabled on all four tables. `anon`/`authenticated` have no direct INSERT/UPDATE/DELETE on protected tables. Column grants omit hidden flags and idempotency keys; policies hide players/disabled boards. pgTAP, direct REST and E2E assertions cover denials. |
| Submission events | `sg_private` has no API schema usage/table grants and is not exposed through PostgREST. No API route or DTO returns events. |
| Definer functions | Only profile operations and submission need `SECURITY DEFINER`; all use `search_path = ''`, qualified references, `auth.uid()` and narrow authenticated EXECUTE grants. PUBLIC/default/service-role grants are revoked. |
| Read functions | Ranking/list/standing functions use `SECURITY INVOKER`, fixed search paths and RLS. Dynamic ranking SQL selects only fixed ASC/DESC fragments; caller values remain SQL parameters. |
| HTTP authentication | `verify_jwt=false` supports mixed public/protected routes. `@supabase/server` verifies a publishable key for every application request and a signed user JWT for protected routes, including issuer, audience, expiry, authenticated role and UUID subject. Secret keys cannot satisfy the user path. |
| Database identity | Caller-scoped RPC clients propagate the verified user JWT. No client-provided player ID or admin client is used. SQL independently derives identity and validates score/bounds/board state. |
| Atomicity | Per-player/board transaction advisory locks serialize quota, replay and writes. Conditional upserts never worsen a best. Concurrency tests exercise different scores, duplicates, quota edges and first profile creation. |
| Error/data handling | Strict bodies, safe integers, 4 KiB limit, bounded returned pages and explicit error mapping. Moderation flags, database details, credentials and stack traces are absent from public DTOs. |
| Deployment | Exact explicit project ref must match manifest/link metadata. Pinned CLI 3.0.0 inspection previews **all** pending migrations, including unrelated SQL. Explicit confirmation precedes mutation; inputs/remote state are rechecked. Partial outcomes are journaled and not blindly retried. |
| Browser packages | Tarball allowlists, generated DTO/assets checks, browser bundling and a real Chromium E2E test. Build canaries and local privileged-key values are checked absent from the built demo. Only public config is selected for the bundle. |

The security-sensitive implementations are in
[core migrations](../modules/core/migrations/),
[leaderboard migrations](../modules/leaderboards/migrations/),
[Edge authentication](../modules/leaderboards/functions/supagame/auth.ts), and
[CLI deployment](../packages/cli/src/commands/deploy.ts).
Existing runtime code and the OpenAPI contract were preserved during Task 11.

## Threats these controls do not solve

- **Scores are client supplied.** A modified client can submit plausible fabricated
  scores. Bounds, safe integers and rate limits are not full anti-cheat. No replay
  verification, authoritative gameplay server or device attestation is included.
- **Anonymous account farming.** Ten submissions per identity/board/minute does not
  prevent an attacker creating more identities. Configure Supabase Auth abuse
  controls, CAPTCHA where appropriate, infrastructure limits and monitoring.
  If CAPTCHA is required, obtain the token in your app and call
  `supabase.auth.signInAnonymously({ options: { captchaToken } })` before the SDK
  helper; `ensureAnonymousSession()` has no CAPTCHA UI/options of its own.
- **Direct RPC access exists.** Authenticated clients can call granted SQL functions
  through PostgREST, so essential identity, validation and throttling rules live in
  SQL. CORS and Edge-only size/format checks are not an anti-abuse boundary for RPC.
- **Events accumulate.** There is no automatic submission-event cleanup/retention
  job in v0.1. Stored events preserve original idempotent outcomes indefinitely.
  Deleting them can let an old key be processed again and change rate-limit
  accounting. Capacity monitoring and any retention change need an explicit policy;
  this release does not promise a bounded event table.
- **Ranking work grows.** Pages return at most 100 entries, but competition ranking
  may scan/sort the visible board. Both ranking indexes exist; PostgreSQL may choose
  a full-board sort. Existing EXPLAIN checks are sanity tests, not a scale/SLA proof.
  The list-boards response itself is not paginated. Load-test your intended sizes.
- **Cursor pages are not snapshots.** Scores or visibility changes between requests
  can move entries. Restart pagination when current consistency matters.
- **Hidden is not a ban.** Hidden players are excluded from rankings; the setting
  does not disable their Auth identity or revoke their ability to submit/update
  their own profile. Moderation tools are outside v0.1.
- **Browser storage/XSS.** Supabase's default browser session storage can be read
  by compromised same-origin JavaScript. Secure the host app, dependencies, CSP,
  redirects and storage. No native secure-storage adapter ships here.
- **Operational privileges.** Database owners can alter RLS, grants or data. Doctor
  checks expected catalog metadata but cannot prove that function bodies or the
  entire project are trustworthy. Deploy previews filenames/hashes, not SQL intent.

## Anonymous identity and linking

Existing permanent accounts are reused; the SDK never intentionally replaces a
failed session with a new anonymous identity. Clearing storage or signing out of
an unlinked anonymous account can lose access permanently. Local concurrency is
coalesced within one JavaScript realm; the caller's Supabase storage/locking owns
cross-tab behavior. JWT revocation follows Supabase's validity rules and is not
promised to invalidate every issued access token immediately.

The local E2E test upgrades an anonymous user by adding email/password with email
confirmations disabled **only in the disposable test project**, then verifies the
same UUID and scores. Do not disable hosted confirmation merely to copy that test.

For a real application, use the caller-owned client while still signed in:

```ts
// Follow the configured email-confirmation flow before treating this as permanent.
const emailResult = await supabase.auth.updateUser({ email: playerEmail });
if (emailResult.error) throw emailResult.error;
// After email verification, when appropriate for your chosen Auth flow:
const passwordResult = await supabase.auth.updateUser({ password: playerPassword });
if (passwordResult.error) throw passwordResult.error;
```

For OAuth, enable manual identity linking, configure the provider and allowlisted
redirect, and link to the current user:

```ts
const { error } = await supabase.auth.linkIdentity({
  provider: 'google',
  options: { redirectTo: 'https://your-game.example/auth/callback' },
});
if (error) throw error;
```

Handle the callback with your Supabase client and platform. Existing-account
collisions need a deliberate application flow; Supagame does not merge players or
scores. OAuth/provider delivery and native deep links were **not** exercised by the
local suite. See Supabase's [anonymous Auth guide](https://supabase.com/docs/guides/auth/auth-anonymous)
and [identity-linking guide](https://supabase.com/docs/guides/auth/auth-identity-linking).

## Origin and credential configuration

`SG_ALLOWED_ORIGINS` is a JSON array of exact origins; empty means no browser origins
are allowed. Use neither `*` nor `null`. Requests without Origin can still use the
API with valid credentials: CORS is a browser control, not authorization.

Set `SG_AUTH_ISSUER` only when the public Auth issuer differs from the runtime URL,
as in the local Docker fixture. Hosted configuration normally uses the project's
public URL; custom domains/issuers need explicit review. Supagame deploy manages
only the anonymous Auth prerequisite and `SG_ALLOWED_ORIGINS`, with explicit
authorization, narrowly scoped writes and read-back verification. Unknown origin
values require explicit replacement consent. The developer’s full configuration
is never pushed; global Realtime channel settings remain unchanged. See the
[installation reference](installation-reference.md). Never commit `.env`, privileged keys, database
passwords, personal access tokens or user JWTs. CI requires no hosted credentials.

## First-PR dependency review (9 November 2026)

`pnpm audit --prod --json` reported no known advisories in the production npm
workspace dependency graph. The full `pnpm audit --json` reported one moderate,
development-only finding: `minimatch` 10.2.6 through ESLint/typescript-eslint,
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
The upstream advisory describes resource amplification from attacker-controlled
glob patterns with `optimizationLevel >= 2`; the patched version is 11.0.1.

This dependency is absent from the CLI/SDK runtime dependency graphs and the
browser bundle. The reviewed lint call sites do not enable that optimization
level, and game/API input does not reach the lint toolchain. It is recorded as a
nonblocking development-tooling finding, not an API vulnerability. Keep lint
configuration trusted and update through a compatible upstream tooling release;
this review does not force a transitive major-version override or suppress the
advisory. Reassess if linting untrusted glob configuration is introduced.

The npm audit does not cover the separately locked Deno graph, container images,
or hosted infrastructure. Existing local security regressions and source review
are complementary checks, not a guarantee that no vulnerabilities exist.

## Optional Admin

See [Admin trust boundaries](admin.md#trust-boundaries-and-bootstrap). Operator
credentials stay in the trusted Supabase CLI process. Private functions, RLS,
revocable assignments, atomic audit records, operation IDs and administrative
revisions protect the CLI workflow. The optional
[local dashboard](admin-dashboard.md#security-and-session-lifecycle) binds only
to loopback and requires a private per-launch code, authenticated sessions,
exact Host/Origin validation and CSRF tokens. Privileged credentials remain
server-side; no hosted administrative endpoint is installed.

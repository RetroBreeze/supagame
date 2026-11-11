# Admin Dashboard v1 verification

Initial CLI 0.1.5 implementation and testing used Node 24.22.2, Supabase CLI 3.0.0 and synthetic local
fixtures only. No hosted project was contacted or modified. No Vaccoin files were
changed. No database migration, public SDK API or Edge Function route was added.

## Architecture review

- Existing CLI and dashboard share `packages/cli/src/lib/admin-service.ts`.
  The established Admin SQL builders/functions remain authoritative.
- Configuration, link metadata and actual connection target are checked before
  startup. An immutable connection and repeated configuration checks prevent
  browser requests or on-disk changes from switching projects.
- Dashboard API has four fixed POST routes; none accept SQL, workdir, connection
  or project-selection fields. All non-login routes require a bearer and CSRF
  token, plus exact Host/Origin and Fetch Metadata checks.
- Existing UUID/revision/audit semantics are preserved. Preview ownership,
  immutable retry payloads, duplicate/concurrent requests and unknown outcomes
  are covered. The CLI retains actionable retry coordinates in sanitized errors.
- Browser code uses DOM text rendering, a strict CSP and no persistent credential
  storage. Chromium verified hostile database strings remain text.
- Production assets are bundled into CLI 0.1.5's `dist/dashboard`; there are no new
  runtime dependencies. The public SDK/contracts and database module versions
  remain unchanged.

## Test evidence

| Check | Result |
| --- | --- |
| `pnpm test` | 454 passing unit tests across 31 files, including 20 new dashboard tests |
| `pnpm test:db` | 809 baseline pgTAP assertions, 38 Admin assertions and 21 concurrency tests pass |
| `pnpm test:cli:db` | 28 passing CLI/database checks |
| `pnpm test:edge` | 84 passing Edge unit tests |
| `pnpm test:edge:integration` | All 13 integration steps pass |
| `pnpm test:sdk:integration` | 11 passing SDK integration tests |
| `pnpm test:e2e` | 15 passing tests, including Chromium UI and installed-dashboard local Supabase operations |
| `pnpm test:packages` | Fresh CLI 0.1.5, SDK and contracts tarballs install into an isolated consumer; dashboard assets and command are present |
| `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm contracts:check` | Pass |

The installed-dashboard integration starts the **tarball's CLI** from an isolated
game directory, performs real read-only startup verification, authenticates over
HTTP, and tests leaderboard inspection/reset/disable/enable, score hide/restore,
player restrict/reinstate, audit visibility, stale previews and idempotent retries.
It also checks 50-row keyset pagination over 58 synthetic accepted submissions,
then terminates the CLI with SIGTERM and verifies its listener is closed.

Chromium checks login, the prominent hosted project identity, all-text rendering
of a hostile HTML string, loading/empty states, required reason and exact target,
unknown-operation failure without false success, retry with the same payload,
desktop/tablet/mobile layout behavior, and empty browser storage. A screenshot
was inspected during development; generated images remain outside the repository.

Security failure tests cover missing/invalid credentials, foreign/null/missing
Origins, DNS-rebinding Host names, CSRF, same-site requests, preflights, malformed
and oversized JSON, unexpected methods/routes/connection fields, invalid action
and target inputs, cross-session previews, concurrent operation execution,
credential-redacted errors, port conflict and listener shutdown. Configuration
tests cover explicit mode, missing Admin, inconsistent references, ambiguous
JSON/TOML config, on-disk changes, incomplete security results and operator denial.

## Limits and scope

No independent external security audit was performed. Review was inline under
the repository's no-subagents instruction. Tests use isolated local data; hosted
authentication behavior continues to rely on the existing supported Supabase CLI
adapter. SIGINT and SIGTERM share the same shutdown handler; SIGTERM is exercised
by the packaged integration test.

The dashboard deliberately has no project switcher, delegated in-game access,
hosted server, automatic destructive retry or reset undo. Session/preview
lifetimes and bounded read limits are documented in [Admin Dashboard](admin-dashboard.md).
Counts and filtering over large installations may time out. Audit attribution
remains the database role, not an independently identified person. Browser reload
requires authentication again, and expired/lost previews require checking audit
history before any replacement operation.

## CLI 0.1.6 authorization fix — 11 November 2026

The reported failure was reproduced using Vaccoin's existing Supabase operator
login and the shared service, without modifying its files or hosted data.
Resolution selected `/home/shem/Projects/vaccoin`, local name `vaccoin`, and
reference `ttwppnsnxcighfcesxhf`. Both command paths use the same resolver,
isolated Supabase configuration, explicit remote reference and sanitized process
environment. There was no missing credential propagation or alternate project.

Two fixed metadata SELECTs using that same connection established the difference:

| Transport | current_user / session_user | transaction_read_only | Admin EXECUTE |
| --- | --- | --- | --- |
| Hosted `db query --read-only` | `supabase_read_only_user` | on | false |
| Hosted normal `db query` (same path as Admin CLI mutations) | `postgres` | off | true |
| Local `db query --read-only` | `postgres` | on | — |

The dashboard checked the read-only transport's role. Supabase intentionally
changes that role for hosted reads; the permission result was a correctly parsed
JSON boolean `false`. Doctor only checks installation security, and CLI mutations
use the operator transport, explaining why both could work. Local E2E missed the
defect because its read-only connection retains `postgres`. This matches the
[CLI read-only transport documentation](https://supabase.com/docs/reference/cli/supabase-db-query)
and [Management API read-only role](https://supabase.com/docs/reference/api/v1-read-only-query).

The fix runs **only the fixed, side-effect-free permission SELECT** through the
operator transport. `--yes` acknowledges that known SELECT to Supabase CLI; it
does not authorize or perform a mutation. No browser input can affect the SQL.
Both the `postgres`/`supabase_admin` allowlist and `admin_apply` EXECUTE check are
unchanged. Ordinary reads and doctor remain read-only. A new exact-one-row check
rejects ambiguous responses; unavailable probes have sanitized diagnostics distinct
from permission denial. No additional database privilege is required.

Regression evidence:

- The source transport test and freshly packed 0.1.5 consumer failed before the
  fix. Both pass with 0.1.6. The package test models the observed hosted role split,
  launches from the consumer's current directory, authenticates over loopback and
  checks the explicit immutable target and isolated workdir.
- Twelve new unit cases cover the role split, the same operator transport as CLI
  mutations, preserved read-only queries, denied/malformed/multiple-row results
  and redacted subprocess errors.
- A local PostgreSQL integration test evaluates the production permission SQL
  against the actual Admin migration in rolled-back transactions: both trusted
  roles, revoked owner EXECUTE, the read-only role, authenticated users, and
  ordinary roles even with synthetic EXECUTE grants. All eight cases pass.
- A separate fresh 0.1.6 tarball installation successfully started from Vaccoin's
  current directory against the reported hosted reference on Node 24.22.2.
  Launch-code login, static page HTTP 200 and clean shutdown were verified.
  No Admin action was requested, no hosted data/grants were changed, and Vaccoin's
  working tree status remained unchanged. The existing Vaccoin installation was
  not replaced; the release was installed in a disposable consumer directory.

All commands below ran with Node 24.22.2 and Supabase CLI 3.0.0:

| Command | Result |
| --- | --- |
| `pnpm test` | 466 tests pass in 31 files, including dashboard security |
| `pnpm test:db` | 809 pgTAP assertions, 38 Admin assertions, eight operator cases, 21 concurrency tests pass |
| `pnpm test:cli:db` | 28 pass |
| `pnpm test:edge` | 84 pass |
| `pnpm test:edge:integration` | 13 integration steps pass |
| `pnpm test:sdk:integration` | 11 pass |
| `pnpm test:e2e` | 15 pass, including Chromium and installed local dashboard actions |
| `pnpm test:packages` | Fresh 0.1.6 consumer and hosted transport startup regression pass |
| `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm contracts:check` | Pass |
| `git diff --check` | Pass |

Release artifact: `dist/supagame-cli-0.1.6.tgz` (ignored by Git). SHA-256:
`d6c24bf1fdd04a460c85f6b8a753c8ef5e65d01af0efc9706f3510d672bf36ce`.
SDK/contracts and database module versions are unchanged. Review was inline under
the repository's no-subagents rule. No push, publication or deployment occurred.
Automated tests require no hosted credentials; real hosted verification was
limited to the non-mutating startup checks above.

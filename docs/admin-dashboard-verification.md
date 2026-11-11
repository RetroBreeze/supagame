# Admin Dashboard v1 verification

Implementation and testing used Node 24.22.2, Supabase CLI 3.0.0 and synthetic local
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

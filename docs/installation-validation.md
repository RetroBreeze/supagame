# Installation validation — 10 November 2026

Tested with Node 24.22.2, pnpm 12.18.0, Supabase CLI 3.0.0 and the repository's
locked dependencies. The implementation retains manifest format 1, existing SQL
versions, HTTP behavior and migration/function deployment receipts.

## Automated checks

| Command | Result |
| --- | --- |
| `pnpm test` | Pass, including origin, provisioning, partial failure, redaction and compatibility coverage |
| `pnpm test:edge` | Pass: 80 tests |
| `pnpm test:db` | Pass: 709 pgTAP assertions plus 18 concurrency tests |
| `pnpm test:e2e` | Pass: 10 tests, including real Chromium and private local Realtime Broadcast |
| `pnpm typecheck` | Pass: workspace, test and Edge checks |
| `pnpm lint` | Pass: workspace and Edge lint/format |
| `pnpm build` | Pass: CLI, contracts, SDK and browser example |
| `pnpm contracts:check` | Pass |
| `pnpm test:packages` | Pass: installed tarballs outside the repository |
| `pnpm test:cli:db` | Pass: 23 tests, including rolled-back catalog/security drift |
| `pnpm test:edge:integration` | Pass: 12 integration steps |
| `pnpm test:sdk:integration` | Pass: 8 tests |

Hosted mutation behavior is mocked. Realtime Management API reads are tested with
mocked HTTP responses, including missing permissions, suspension, incomplete
responses and redaction. The saved-login configuration/secrets transport uses
mocked CLI responses matching actual read-only CLI 3.0.0 inspection. No hosted
write was used to complete a test.

The local E2E fixture now obtains browser origins and issuer configuration from
the installed CLI. It starts the local Realtime service before applying the
optional migration, verifies installation with doctor, and receives a real private
Broadcast after a synthetic local best score. Local tables/users are disposable.

## Vaccoin consumer

The rebuilt CLI tarball was installed in `~/Projects/vaccoin`. Its Supabase CLI
version is now pinned to 3.0.0; the previous caret range allowed npm to select
3.1.0, which Supagame refused. Changes are limited to package metadata/CLI archive
integrity and installation documentation. Vaccoin's 92 unit tests and production
build pass (the build retains its existing large-bundle advisory).

Actual read-only dry run:

- Destination: `vaccoin`, `ttwppnsnxcighfcesxhf`.
- Manifest/deployed schema: Core 0.1.0 and Leaderboards 0.1.0.
- No pending migrations for those modules; anonymous Auth verified enabled.
- Existing manifest does not declare browser origins, so doctor reports them
  unmanaged/unverifiable instead of guessing.
- Function status/JWT configuration is healthy; the previous receipt cannot prove
  content identity, so a deployment preview proposes a function redeploy.

A disposable copy of Vaccoin's provisioning files was configured with
`http://localhost:5173` and `http://10.0.0.15:5173`, then Live Leaderboards was added
twice. Read-only hosted inspection proved:

- Both origins exactly match the hosted secret digest; no replacement is needed.
- Exactly one migration is pending: `20261110000100_live_leaderboards.sql`.
- Database Broadcast helpers, Realtime RLS and authenticated receive grants exist.
- Live Leaderboards' trigger function, triggers and policies are not deployed yet.
  Doctor reports their absence instead of inferring health from staged files.
- Hosted service health/WebSocket delivery was not verified; no extra Management
  API token or player session was obtained. Real hosted gameplay remains the final
  delivery check after an explicitly authorized deployment.

The actual consumer's pre-existing untracked manifest and `supabase/` files were
preserved. `init --origin ... --dry-run` and `add live-leaderboards --dry-run` also
passed in the actual consumer directory. No hosted scores, users, broadcasts,
settings, functions or database objects were created or changed.

## Commands for the existing consumer

With Node 24 and the rebuilt archive in `~/Projects/supagame/artifacts`:

```sh
cd ~/Projects/vaccoin
npm install --save-dev --save-exact supabase@3.0.0 ../supagame/artifacts/supagame-cli-0.1.0.tgz
npx --no-install supagame init --project-ref ttwppnsnxcighfcesxhf --origin http://localhost:5173 --origin http://10.0.0.15:5173
npx --no-install supagame add live-leaderboards
npx --no-install supagame deploy --project-ref ttwppnsnxcighfcesxhf --dry-run
npx --no-install supagame deploy --project-ref ttwppnsnxcighfcesxhf
npx --no-install supagame doctor --remote --project-ref ttwppnsnxcighfcesxhf
```

The mutating deployment command still requires typing
`deploy ttwppnsnxcighfcesxhf`. The preview must be reviewed again at execution time;
this read-only validation is not hosted mutation authorization. If the hosted
origin value changes later, the explicit replacement safeguard applies.

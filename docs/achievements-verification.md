# Achievements local verification — 10 November 2026

No packages were published, repositories pushed, or hosted Supabase state changed.
All database/API integration tests used synthetic identities in local fixtures.

| Command/check | Final result |
|---|---|
| `pnpm test` | 361 passed, 22 files (includes optional DOM helper Chromium test) |
| `pnpm db:migrate` | New achievement migration applied locally |
| `pnpm test:db` | 724 SQL assertions across 7 files; 19 concurrency tests passed |
| `pnpm test:cli:db` | 25 passed, including achievement policy/grant drift |
| `pnpm test:edge` | 81 passed |
| `pnpm test:edge:integration` | 1 suite / 13 steps passed |
| `pnpm test:sdk:integration` | 8 passed |
| `pnpm test:packages` | 1 passed; clean tarball consumer |
| `pnpm test:e2e` | 10 passed; packaged install, Auth, SDK, HTTP, Chromium and Live Leaderboards |
| `pnpm contracts:check` | Passed OpenAPI and generated-validator consistency |
| `pnpm lint` | Passed ESLint, Deno lint and Edge format checks |
| `pnpm typecheck` | Passed root/workspaces and Deno Edge checks |
| `pnpm build` | Passed all packages and browser example |
| Final 0.1.1 archives | Every archived dist file compared byte-for-byte to final build; required assets checked before Vaccoin consumption |
| Vaccoin `npm test` | 99 passed, 15 files, including existing user edits |
| Vaccoin `npm run build` | Passed TypeScript and Vite; existing large-chunk advisory remains |
| Vaccoin `npm run test:browser` | Passed mocked gameplay/navigation regression |
| Vaccoin `npm run test:browser:live` | Passed mocked desktop/mobile live leaderboard checks |
| Vaccoin `node scripts/achievements-browser-test.mjs` | Passed menu, four unlocks, FIFO notification, Escape, desktop/mobile screenshots; screenshots visually reviewed |
| Vaccoin existing `node scripts/name-edit-test.mjs` | Passed on diagnostic rerun with identical assertions; initial connection wait timed out |
| Vaccoin local `supagame doctor` | Local module/assets/definitions healthy; hosted/live database checks explicitly unverified |
| Vaccoin exact staged tree | Separate build and 96 tests passed, excluding pre-existing user edits |

Environment: Node 26.13.0, pnpm 12.18.0, Supabase CLI 3.0.0. The package's declared
Node engine is 24; npm emitted an engine warning. Node 24-specific verification
was not performed. Packaging subprocess tests used pnpm's installed native
executable in PATH because Node could not spawn this machine's shebang-less
pnpm launcher. The existing stopped local Edge container was started before
rerunning the successful Edge/SDK integration suites.

Review was performed inline; repository instructions disallow delegation
without the user's explicit request. Pre-existing Supagame untracked files and
Vaccoin UI/name-edit changes were preserved. Vaccoin's existing untracked base
Supabase provisioning files remain local; only the new achievement migrations
and updated manifest are included in the achievement commit.

Limitations: descending score thresholds only; polling notifications intentionally
suppress hydration/offline history and are not a durable inbox. Backfill timestamps
come from retained personal bests. Full catalogs are returned without pagination.
See `achievements.md` for trust boundaries and integration details. Hosted
project `ttwppnsnxcighfcesxhf` requires a separately confirmed deployment.

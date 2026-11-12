# Release review fixes

Scope: the four findings explicitly authorized on 12 November 2026, in priority
order. Execute inline with systematic debugging and TDD. Keep public APIs,
package names and `private: true`; preserve Vaccoin consumers and existing user
edits. No hosted mutations, publication or unrelated refactoring. Commit after
the complete verification run.

## Plan

1. Account-switch error isolation: add regression tests in
   `tests/sdk/transport-identity.test.ts` for both Supabase Functions and custom
   fetch transports. Cover switching users/signing out before the response and
   while its error body is read, and preserve same-player conflict details.
   Fix `packages/sdk-ts/src/client.ts` without changing exported signatures.
2. Live refresh progress: reproduce sustained broadcasts during slower snapshots
   in `tests/sdk/live.test.ts`. Keep one in-flight snapshot, publish completed
   reads and coalesce a trailing refresh. Retain suppression after auth changes,
   disconnects and disposal in `packages/sdk-ts/src/live.ts`.
3. Achievement SQL: execute generated migrations with dollar delimiters, quotes,
   backslashes and newlines in PostgreSQL. Fix only the generator in
   `packages/cli/src/lib/achievements.ts`; keep byte-identical output for existing
   safe definitions so installed migrations, doctor and upgrade remain compatible.
4. Package artifacts: reproduce missing runtime files from a fresh source copy.
   Add packaging lifecycle builds and artifact validation for CLI, contracts and
   SDK. Extend `tests/e2e/packages.test.ts` to verify clean-source packaging and
   isolated installation, including the browser entry point and CLI assets.

For each step, observe the regression fail before implementing, then pass its
focused suite. Use Node 24.22.2 and the installed native pnpm binary. Review the
complete diff without delegation (repository instructions prohibit subagents).

## Final verification

Run build, unit tests, Edge tests, typecheck, lint, contract freshness, database
and concurrency tests, CLI/database tests, HTTP and SDK integration, tarball
consumer tests and the complete local end-to-end suite. Verify a fresh source
checkout without `dist`, and preserve all pre-existing documentation changes.
Record actual results and limitations here before committing.

## Reproductions and fixes

1. **Account-switch error exposure.** The new regression initially failed six
   cases across the Functions and custom-fetch transports: a pending save from
   player A returned `SaveConflictError.current` after switching to player B or
   signing out. Success responses checked the current identity, but HTTP error
   handling returned before that check. Error handling now checks identity both
   before and after reading the response body. Switching during a delayed body
   read is covered too. Same-player token refresh still returns the normal
   conflict payload. Public method signatures and error classes are unchanged.
2. **Live refresh starvation.** Both transport regressions originally delivered
   zero updates with broadcasts every 100 ms and snapshots taking 250 ms. Every
   broadcast incremented the generation, so each completed snapshot was rejected.
   Broadcasts now mark a trailing refresh as needed without invalidating the
   current read. Auth changes, reconnects and disposal still invalidate reads.
   Tests verify continued updates, one concurrent top/personal request pair,
   eventual idle state, and no callbacks after disposal.
3. **Achievement migration quoting.** Generated migrations containing
   `$supagame$` failed with PostgreSQL syntax errors in both regression cases.
   PostgreSQL recognizes the outer dollar delimiter even inside the enclosed
   SQL string literal. The generator now selects a delimiter absent from the
   serialized definition, including when numbered alternatives also occur.
   Tests execute each migration twice against local PostgreSQL and verify exact
   round trips for quotes, backslashes, newlines, delimiters and nested metadata.
   A fixture captured before the fix confirms byte-identical generation for
   previously safe definitions, preserving doctor/upgrade compatibility.
   No previously applied migration was edited.
4. **Incomplete npm artifacts.** Packing a fresh clone originally produced an SDK
   archive with no runtime entry point. Packing had no build prerequisite and
   relied on existing ignored `dist` output. All three packages now have a
   `prepack` hook that clears generated output, builds, and checks nonempty
   public exports/binaries. CLI checks also cover staged module assets and the
   dashboard. SDK packing builds contracts first. The regression clones source
   without any `dist`, installs locked dependencies, packs the SDK first, and
   installs all three archives in an isolated consumer. It exercises runtime
   imports, declarations, browser bundling, CLI commands and operator transport.
   Repacking removes injected stale artifacts. A successful compiler invocation
   with `noEmit` is explicitly rejected before any tarball is produced.

## Verified results

Executed on Linux with **Node.js 24.22.2**, pnpm 12.18.0, Deno 2.9.6 and
Supabase CLI 3.0.0. All commands below passed after the fixes:

| Command | Result |
| --- | --- |
| `pnpm build` | All workspace packages built |
| `pnpm test` | 477 tests passed across 32 files |
| `pnpm test:edge` | 84 passed |
| `pnpm typecheck` | Root, packages and Edge checks passed |
| `pnpm lint` | ESLint, Deno lint and Edge formatting passed |
| `pnpm contracts:check` | Contract types and SDK validators current |
| `pnpm test:db` | 809 SQL assertions, 2 admin tests and 21 concurrency tests passed |
| `pnpm test:cli:db` | 30 passed, including generated achievement SQL execution |
| `pnpm test:edge:integration` | 1 test with 13 steps passed |
| `pnpm test:sdk:integration` | 11 passed |
| `pnpm test:packages` | Fresh-source, isolated-consumer, stale-output and rejected-pack checks passed |
| `pnpm test:e2e` | 15 passed, including Chromium, real local Broadcast and packaged Admin operations |

Vaccoin compatibility was tested in a separate temporary clone with all three
new tarballs in its existing `vendor/` layout and updated integrity checksums.
`npm ci --ignore-scripts --no-audit --no-fund`, `npm test` (242 tests),
`npm run build` (TypeScript and Vite), and the installed `supagame --help` passed
under Node 24.22.2. An initial consumer setup used external tarball paths and
failed Vaccoin's portability assertion; preserving its vendor layout resolved
that setup error without changing application code or tests. The real Vaccoin
checkout was not modified.

## Remaining limitations and release constraints

- Packaging is performed from the installed pnpm source workspace with lifecycle
  scripts enabled, sequentially per package; SDK packing also rebuilds contracts.
  Use `pnpm --dir packages/<name> pack --pack-destination <directory>` so workspace
  dependencies are rewritten for external consumers. `--ignore-scripts` bypasses
  the build gate and is unsuitable for producing release artifacts.
- Validation used the stated Node 24 patch on Linux and local synthetic Supabase
  installations. Hosted deployment and provider OAuth behavior were not retested.
- Vaccoin's Vite build retains its existing nonfatal large-chunk warning.
- The additional Vaccoin `npm run test:browser:live` check timed out waiting for
  its first snapshot (`scripts/live-browser-test.mjs:14`) with the new SDK and
  again with Vaccoin's original vendored SDK under the same synthetic browser
  configuration. Its live-browser compatibility is therefore not established by
  that check. This existing test/environment failure was left outside the four
  fixes; Supagame's real local Realtime end-to-end test passed.
- Package names, versions, public APIs and `private: true` remain unchanged.
  Nothing was published. Existing documentation edits were excluded from this
  change. Publication remains a separately authorized release step.

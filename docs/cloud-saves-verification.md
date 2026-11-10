# Cloud Saves verification — 10 November 2026

All final commands used **Node v24.22.2**, not the machine's default Node 26. Supabase CLI was 3.0.0. Database, Auth, Storage and Edge integration ran against synthetic local Docker stacks. No hosted Supabase mutation, package publication or Git push was performed.

| Command | Result |
| --- | --- |
| `pnpm test` | 376 tests, 25 files passed |
| `pnpm test:db` | 767 pgTAP assertions, 10 SQL files; 20 concurrency tests passed |
| `pnpm test:cli:db` | 28 tests passed |
| `pnpm test:edge` | 83 tests passed |
| `pnpm test:edge:integration` | 1 suite / 13 integration steps passed |
| `pnpm test:sdk:integration` | 10 tests passed, including real private Storage and interrupted upload retry |
| `pnpm test:packages` | 1 clean-install/package suite passed |
| `pnpm test:e2e` | 11 tests passed against a fresh packaged installation, including JSON/binary saves and Chromium |
| `pnpm typecheck` | Passed, including packages and Deno Edge checks |
| `pnpm lint` | Passed, including Edge lint/format |
| `pnpm contracts:check` | OpenAPI types and runtime validators current |
| `pnpm build` | All package and example builds passed |
| `git diff --check` | Passed |

The TDD sequence included failing lifecycle, SDK/offline, installer, Workshop and rate-limit cases before implementation. Real Storage integration exposed both an ambiguous PL/pgSQL identifier and Storage's preflight `contentLength` metadata; additive migrations corrected these without rewriting applied migrations. A newly added API source file required restarting the local stack so the Edge container mounted its dependency graph. One existing CLI unit test exceeded its five-second timeout while several heavy checks ran concurrently; the complete unit suite passed when rerun without that contention.

Security checks cover caller-derived identity, owner RLS, direct write denial, anonymous/expired/invalid credentials, immutable Storage objects, restrictive policies even with unrelated broad host policies, size reservations, stale revisions, failed replacement/commit, abort/cleanup and concurrent writers. Operator cleanup was exercised on a synthetic local orphan, with additional HTTP, network and database-acknowledgement failure tests. The cleanup workflow preserves registry state on failure and never deletes a referenced live version. Review was performed inline; no subagents were used.

Default quotas and the 60 successful mutations/minute/player throttle are database enforced. Idempotent receipts bypass the write throttle. The existing hosted-deploy confirmation and exact-target tests remain passing; the new module follows the same inventory/deployment path.

## Package provenance

Fresh 0.1.2 archives were built, packed and installed in Vaccoin. Every installed `dist` file was compared byte-for-byte with both its archive and current build (6 contracts files, 60 SDK files, 90 CLI files). See Vaccoin's `docs/workshop-verification.md` for SHA-256 hashes.

## Scope and limitations

- Cloud Saves extends the original v0.1 plan under the explicit new user request. It shares the existing Edge runtime owned by the leaderboards module; installation resolves that dependency automatically.
- JSON uses PostgreSQL; binary uses immutable private Storage objects with metadata commit and recoverable cleanup. Uploads restart rather than resume, and the current Blob API buffers file data in memory. The default binary limit is 50 MiB; multi-gigabyte resumable transfers need a future client implementation.
- Tombstones and idempotency receipts intentionally persist. Their growth and anonymous-account abuse require operator capacity planning; they are not a complete anti-abuse system.
- IndexedDB durability cannot survive browser storage deletion. Unlinked anonymous sessions cannot recover across devices after their credentials are lost.
- Hosted bucket/policy/Auth/Edge state and platform-wide Storage limits were not inspected or changed. Local doctor distinguishes file checks from these unverifiable states.
- No unresolved cross-player access or revision-bypass defect was found in the implemented test/review scope. This is not an independent security audit. Client-controlled saves are not an authority for leaderboards or achievement unlocks.

See [Cloud Saves architecture and quickstart](cloud-saves.md) for API, deployment and recovery procedures.

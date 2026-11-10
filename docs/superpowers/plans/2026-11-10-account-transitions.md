# Account linking, recovery and save transitions

User-authorized single implementation pass across Supagame and Vaccoin. The current request supersedes the original v0.1 exclusions. No hosted mutations, credentials, publishing, pushes, or subagents. Preserve pre-existing edits; commit only this work.

## Design and sequence

1. Add SDK player account status, explicit provider linking/sign-in, PKCE callback verification, restoration, sign-out and subscriptions. Persist expiring flow intent in a project-scoped durable store; never put tokens in transfer records. Verify linking preserves the original Auth ID. Keep provider extensibility via Supabase Provider.
2. Add saves.prepareAccountSwitch / inspectAccountSwitch / resolveAccountSwitch. IndexedDB stores bounded JSON/Blob snapshots and pending local overrides before OAuth. Bind a transition to its verified sign-in flow and target ID. Preserve guest snapshots and target backups; use existing authenticated CAS/idempotency HTTP mutations. Persist chosen payload and operation IDs before writes for restart-safe retries. Cancellation changes no saves. Backup exports contain save data only. No server-authoritative record migration.
3. Add CLI auth configuration preview/read-only diagnostics using the documented Management API Auth config endpoint. Merge redirect URLs, narrowly patch only requested fields after destination verification and confirmation. Secrets come from environment only and are never printed/staged. Keep Auth redirects separate from CORS.
4. Integrate Canvas account controls/conflict UI in Vaccoin. Pause Workshop synchronization during transition; snapshot pending operations. On account change isolate runtime profile, achievements, leaderboard and Workshop state. Deterministic custom merge unions cosmetics and operation IDs, explicitly selects one wallet/statistics/preferences/equipment source, rejects conflicting operation signatures.
5. Rebuild/pack affected packages; install fresh tarballs into Vaccoin. Run unit, database/concurrency, Edge, CLI, integration, E2E/package, contract, type/lint/build checks on Node 24. Exercise desktop/mobile with mocked OAuth. Document real OAuth setup and known limits; review and commit locally.

## Review focus

- Reload/lost-response retry retains chosen payload and IDs; never overwrites a newer revision.
- Storage quota / oversized binary fails before redirect or replacement; backups include actual binary bytes.
- Callback missing/expired/replayed state, changed user, provider errors fail closed with sanitized errors.
- Guest pending changes and target pending local changes stay isolated and recoverable.
- Keep Cloud does not replay guest wallet/cosmetic operations. No score/achievement writes from saves.

## Decisions

Use client durable backups rather than new server ownership APIs. Backup availability is tied to this browser storage; explicit export supports off-device recovery. Multi-slot imports are journaled per slot, not an atomic transaction across slots; failed imports remain resumable with completed slots recorded. Binary transfers are bounded and sequential, stored as Blobs in IndexedDB, never base64 localStorage. Developers must supply unsynchronized local state through the preparation hook; arbitrary application memory cannot be discovered by an SDK.

## Execution ledger

- Read original design/plan and existing SDK/CLI/Vaccoin code; captured user edits outside repositories. Initial runtime Node 26; Node 24 selected for verification.
- Implemented and reviewed SDK auth, durable transitions, bounded binary download guards, explicit re-review after CAS conflicts, offline queue preparation, CLI Auth configuration/diagnostics, and Vaccoin integration.
- TDD observed missing methods/failing behaviors before implementation, including callback identity checks, snapshot/import consent, revision conflicts/re-review, binary download budgets, pending Workshop capture, wallet merge rules, account-specific names/bests and portrait overlay handling.
- Self-review used because repository instructions prohibit subagents. Found/fixed callback query allowlisting, source recovery exposing target backups, concurrent tombstone deletion handling, stale authenticated responses and binary metadata/download races.
- Decisions: Cancel is a save-operation cancellation, not an OAuth rollback. The authenticated target stays signed in and no saves change. Target-only slots outside the prepared guest slots are untouched. Backups are device-local and exportable. No backend schema/API migration was needed.
- Verification on Node 24.22.2: 414 unit/CLI/SDK tests; 767 SQL assertions; 20 concurrency tests; 28 CLI database checks; 83 Edge tests; 13 Edge integration steps; 11 SDK integration tests; package installation test; 11 E2E tests; typecheck, lint, contract checks and build passed.
- Vaccoin: 128 working-tree unit tests and production build passed. An isolated export of the staged commit independently passed 118 tests and build without the user's prior edits. Desktop/mobile account controls and mocked OAuth linking/Keep Cloud/Keep Guest/merge passed. Existing gameplay, live leaderboard, achievements and Workshop browser scripts passed. Initial gameplay timing timeout under concurrent Chromium load passed on an isolated rerun. Production bundle size warning remains.
- Supagame 0.1.3 packages rebuilt/packed and installed into Vaccoin; installed auth, transition, binary-save and CLI files compared byte-for-byte with current build output. No hosted mutations, Google credentials, publication or pushes.

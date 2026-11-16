# Pre-release remediation: compatibility decision

Status: proposed, awaiting authorization of the Cloud Saves protocol/retention change.
This document does not describe completed fixes or verified benchmark results.

## Scope and inspected state

Resolve the five findings in the user's pre-release remediation request. Work is
local only: no hosted deployment, resets, publication, private-flag changes, tags,
pushes, or Wiki pushes. Preserve the existing npm-readiness working-tree changes.

Inspected the original product design/implementation plan, Cloud Saves and account
recovery plans, SQL through Cloud Saves 007, the contracts, SDK and offline queue,
module inventory/staging, and existing database/concurrency/plan tests. The module
migrations are immutable source assets mapped to timestamped files by the CLI;
new migrations must enter that inventory and its forward-upgrade paths, not
rewrite existing SQL or legacy snapshots.

The current Cloud Saves contract says every successful mutation is idempotent by
operationId, without an expiry. Requests use per-slot expectedRevision, with zero
meaning create-only. Receipts are checked before revision comparison. Deletion
retains a tombstone; the offline adapter persists operation IDs and expected
revisions and predicts subsequent revisions by incrementing them.

## Confirmed compatibility conflict

Consider an accepted create request R with operation ID X and expectedRevision=0.
The slot is subsequently deleted. R is safe today: its receipt acknowledges the
old result, or the tombstone prevents another create. If both records are removed,
R has exactly the fields of a valid new create for an absent slot. The current
protocol has no generation, expiry, or server-issued write token to distinguish
them. An old create that never reached the server has the same problem.

Thus unlimited distinct slot names, indefinite exact replay, arbitrarily delayed
requests, continued writes, and bounded metadata cannot all be preserved with the
current protocol. A TTL alone does not solve this. A permanent metadata cap avoids
unsafe deletion but eventually stops ordinary writes and slot creation.

Source anchors: packages/contracts/openapi.yaml:555, modules/cloud-saves/migrations/
007_save_revisions.sql:97 and :181, packages/sdk-ts/src/offline-saves.ts (stage,
resolve and sync). This is a protocol argument, not a reproduced Storage upload.

## Approaches

1. **Recommended: bounded history with per-user generations.** Require an observed
   generation on mutations. Advance it atomically before forgetting history.
   Stale requests fail closed; retained receipts can still acknowledge exact
   retries. Supports continued writes and recycling slot names, with explicit
   offline reconciliation after a generation change.
2. **Expiring server-issued write tokens.** Bind writes to a snapshot and expiry;
   retain tombstones at least until all relevant tokens expire. Also requires a
   client protocol change, adds token/key lifecycle and timestamp semantics, and
   still needs count/byte limits under high traffic. Not recommended for this
   remediation's scope.
3. **Keep the protocol and permanently cap historical operations/slot names.**
   Preserves indefinite replay but eventually makes an account unable to save.
   Does not satisfy the requested sustainable normal workflow.

## Recommended semantics requiring approval

- Add an opaque per-user generation to Cloud Saves context responses and require
  the observed generation on new mutations. It must never repeat. Preserve
  per-slot expectedRevision and its ordinary +1 behavior within a generation.
- Authenticate first. Under the existing per-user transaction lock, check a
  retained operation's exact fingerprint before considering a new mutation.
  An exact retained retry returns the old result without reapplying it;
  conflicting reuse returns DUPLICATE_KEY_CONFLICT.
- For an operation without a retained receipt, a missing or stale generation
  never mutates data. Use INVALID_SAVE for missing required protocol input and
  SAVE_CONFLICT for stale context, with a documented reason and current context.
  A retry must never be silently converted into a new operation.
- Bound completed receipts to 4,096 per user and an eligible replay age of 30
  days. When capacity requires pruning, prune a batch of the oldest receipts to
  3,072 before admitting more work. Guarantee exact replay for the most recent
  3,072 completed operations younger than 30 days; older receipts may remain
  temporarily but carry no stronger guarantee. This replaces indefinite replay.
- Bound tombstones without retained backups to 1,024 per user. Backed slots remain
  independently bounded by max_slots and keep their tombstone while backups
  require its revision identity. Batch reclamation may remove old unbacked
  tombstones; advance the generation in the same transaction before removal.
- Advance generation whenever discarding an operation/reservation identity could
  make a former request appear new, including owner cleanup and operator cleanup.
  Check the request against the resulting generation before admitting new work.
  Cleanup progress must commit even when the triggering write returns a conflict;
  raising an exception that rolls back the cleanup would cause a retry loop.
- Bound reservation-registry metadata to 4,096 rows per user, including pending,
  live and garbage rows; retain existing tighter pending/payload quotas. Never
  forget physical objects to meet this limit. At capacity, require safe Storage
  cleanup and return the established quota error for new reservations.
- Apply explicit serialized-size limits to receipt and reservation metadata
  (proposed 8 KiB each, checked against all existing valid response/request
  shapes). Report logical bounds separately from measured heap/index bytes and
  normal PostgreSQL vacuum/bloat behavior; do not promise a hard disk-size cap.
- Preserve five backups per slot for up to 30 days and existing payload quotas.
  Never discard a live save or a nonexpired retained backup to free metadata.
- Keep pending offline payloads, binaries and recovery history. Bind each staged
  intent to its observed generation. A legacy queue or a stale generation requires
  a fresh read and explicit application reconciliation, not automatic rebasing.
  Client caches must compare generation and revision together. A retained receipt
  is historical acknowledgment, not proof that its snapshot is current.
- Generation rotation can conflict with another slot's in-flight write or upload
  for that user. Surface that conflict and retain local data. Do not silently
  upload an old intent using fresh context. New intents after reconciliation use
  new operation IDs. Conflicting ID reuse is detectable only while its identity
  is retained; global never-reuse remains a client requirement.

### Exact compatibility implications

Existing raw-HTTP clients and old SDK Cloud Saves writers must upgrade because
they do not send generation context. Existing persisted offline queues cannot be
blindly replayed. Successful operations no longer have an indefinite receipt
lookup guarantee. Strict old response validators may also reject new context
fields. Coordinate backend/SDK deployment; do not leave a generationless write
path that bypasses the protection. This is a deliberate pre-publication change to
the Cloud Saves v1 contract, not a transparent backward-compatible fix.

Existing live save data and valid backups remain intact. Preserve legacy receipts
and tombstones during migration; initialize generation state without resetting
slot revisions. Oversized historical accounts need explicit, generation-protected
bounded-batch maintenance before accepting growth. Do not hide a data-deleting
bulk cleanup inside the schema migration. Existing leaderboard/profile APIs and
their idempotency semantics are outside this protocol change.

## Implementation and verification after approval

1. Deleted identity: reproduce with real retained JWTs and direct RPC calls;
   distinguish reservation acceptance from completed Storage upload. Check hard
   deletion, soft deletion, Storage ownership constraints and cleanup. Check Auth
   deleted_at as well as existence; use an appropriate row lock that also protects
   against concurrent soft-delete updates. Evaluate session-row revocation
   separately: mandatory session_id checking changes support for custom JWTs and
   is not automatically required merely to reject deleted accounts.
2. Metadata: implement the approved semantics through additive migrations,
   contracts, Edge validation, SDK/cache/offline changes and local documentation.
   Reproduce stale resurrection under naive cleanup before implementing the safe
   alternative. Exercise thousands of mutations with controlled aging, count and
   byte bounds, replay/expiry, offline reconciliation, backups and cleanup races.
3. Throttling: use bounded per-user rate state independent of receipts. Retain the
   completed-write allowance; separately count new reservations and first
   state-changing aborts. Exact retries are free. Cleanup cannot erase counters.
   Evaluate time after lock acquisition. Test boundaries and concurrent requests.
4. Indexes: inspect catalogs and baseline actual plans for the three relationships
   in base and optional-module installations. Add only justified indexes, avoid
   redundant board indexes with Admin history coverage, and measure index bytes,
   representative write cost, cascades and profile-trigger lookups.
5. Pagination: benchmark the actual baseline at 1k/10k/100k and, if safe, 1m rows.
   Investigate indexed page seeking plus global counts with an explicit correction
   for ties straddling the cursor. Retain RLS in the count and page selection.
   Do not implement filter-before-window alone or imply the global count is O(1).
   Compare baseline/optimized plans and use stable work/buffer budgets where
   practical; cover Admin generations, directions, extensive ties and visibility.
6. Register all new assets in CLI inventories and upgrade paths; verify hashes of
   all prior migrations unchanged. Test fresh and forward-upgraded installations,
   late installation of optional modules, journal/recovery safety and packaging.
7. Run the requested local suites and supported Node/CLI matrix. Conduct a fresh
   bypass review before claiming completion. Commit only verified task changes;
   preserve pre-existing npm-readiness changes and all authorization boundaries.

## Current verification and release status

This checkpoint contains source/contract investigation only. Node v26.10.0 and
Supabase CLI 3.0.0 were detected. No database stack was started, no SQL or HTTP
reproductions were executed, and no performance measurements or suite passes are
claimed. No implementation or migration changes have been made. All five issues
remain open. Release recommendation: NO-GO pending approved design, implementation
and successful verification. No commit or external mutation was performed.

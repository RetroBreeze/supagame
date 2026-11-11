# Account transition review follow-up

Scope: address cancellation semantics and durable recovery from transition replacements, without hosted changes or retaining guest credentials.

1. Add regression tests for deferred resolution, actual authentication state, retained guest snapshots, revision creation/restore, failed and repeated writes, isolation, binary recovery, quotas and retention.
2. Extend the existing Cloud Saves RPC in an additive migration. Opt-in replacements archive the prior valid revision transactionally. Retain up to five backups per slot for 30 days; count retained data against existing per-player quotas. Protect referenced binary objects from cleanup. Expose authenticated list/read/restore operations with CAS and idempotent receipts; restoration backs up the current revision.
3. Extend contracts, Edge validation, SDK, and CLI migration inventory. Account transitions always request server backups; no fallback to local-only protection. Preserve local guest recovery independently.
4. Rename post-auth cancellation to deferred resolution with explicit signed-in identity. Keep Google/decline import is keepCloud. Invalidate a pending auth flow only while its source session still exists; do not save or resurrect guest credentials. Update Vaccoin UI/tests/docs.
5. Run local SQL/concurrency, Edge, SDK/CLI, type/lint/contracts/build checks; rebuild versioned tarballs, install in Vaccoin, run tests/build and mocked desktop/mobile browser flows on Node 24. Commit only verified task changes in each repository.

No automatic account merging, identity migration, account deletion, credential copies, or hosted mutations. Restoring game saves never rewrites scores/achievements. Backups use the existing private database schema and Storage bucket; no new service.

Verification and delivery evidence: [account-recovery-verification](../../account-recovery-verification.md). Retained-history slots are also bounded by the existing max_slots setting to prevent tiny payloads from accumulating unbounded archive metadata.

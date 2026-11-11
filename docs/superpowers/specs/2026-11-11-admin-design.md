# Optional Admin design

The requested CLI-first Admin module uses the existing trusted Supabase CLI database connection, isolated workdirs, explicit targets and confirmation. No public administrative HTTP route or game credential is introduced. A future local dashboard can reuse typed operations in the CLI library; delegated game administration must use separate authenticated endpoints and private permission checks.

## Approaches

Use accepted submission events as immutable score identities and generation history, with game_best_scores remaining the current public ranking projection. This preserves existing ranking and achievement consumers. Moving all public reads to a new history table would require broader changes; deleting scores on reset would violate recoverability. The event/projection approach is the implementation choice.

## Transactions and security

Forward-only optional migrations add event UUIDs, generation and moderation state, board revisions, private player restrictions, permission assignments and append-only operation audit records. Operator-only private functions validate action, reason, operation UUID and expected target revision. The database owner retains bootstrap access. Delegated permissions are server-controlled, reject anonymous identities and support revocation; no delegated transport is installed.

Reset locks the board exclusively, advances its generation and clears only the derived best-score projection. Submissions hold a shared board lock and stamp events with that generation. Replays return their original receipt and never write scores. Hide/restore rebuild the affected player's active projection from non-hidden events in the active generation. Historical restore cannot populate the active board. Achievements remain unlocked; saves and profiles remain untouched. Restriction checks serialize with restriction changes.

Disabled boards remain readable. Optional live broadcasts invalidate rankings after administrative changes. All modifications require confirmation and reason, use optimistic revisions, and deduplicate operation IDs. Dry-run and doctor use read-only transactions. Errors must withhold raw subprocess diagnostics.

## Verification

Test optional installation and upgrades, private grants/RLS, operation idempotency and stale revisions, reset/history, moderation/retries, restrictions, ranking reads, concurrency and CLI confirmation/target safety. Run existing regressions and isolated package consumers on Node 24; check Node 26 where practical. No hosted writes.

# Cloud Saves protocol and retention

The first public v0.1.0 protocol requires a `generation` string on every save,
delete, prepare, commit, abort and restore request. Read `/v1/saves` to obtain
context, or retain the generation returned with a loaded save. Persist it with
the operation UUID, expected revision and payload. Do not replace the generation
on an old queued request merely because a newer value is available.

An exact retry is guaranteed for the **latest 3,072 completed operations that are
also less than 30 days old**, per player. This is not a guarantee for every
operation completed in the last 30 days. The server retains at most 4,096 receipts
and may acknowledge additional retained, unexpired receipts. Conflicting reuse
of a retained operation ID returns `DUPLICATE_KEY_CONFLICT`. Exact covered retries
are checked before generation fencing, including completed binary commits after
object-registry cleanup. A replay acknowledges the original result; it does not
restore that result as the current save.

Before forgetting receipts, tombstones or reservation identities, the server
advances the player's generation in the same transaction, under the same advisory
lock used by mutations. A request without a receipt and with an old generation
returns `SAVE_CONFLICT`, including current context. Missing generation is
`INVALID_SAVE`. Keep the local payload, read current state and explicitly choose
which content to retain. Reconciliation creates a new operation ID with the newly
observed generation and expected revision. Never automatically resubmit an old
payload with fresh context. SDK errors distinguish the server's `generation` from
the attempted request's `operationGeneration`.

## Quotas and maintenance

Per player, in addition to configured live-slot and payload limits:

| Metadata | Bound |
| --- | --- |
| Completed operation receipts | 4,096 rows; each new result at most 8 KiB serialized JSON |
| Tombstones without recovery backups | 1,024 rows |
| Slots with recovery backups | Configured `max_slots`, independently of live slots |
| Recovery revisions | Five per backed slot, expiring after 30 days |
| Binary registry (all states) | 4,096 rows; each new request at most 8 KiB serialized JSON |
| Rate state | Three arrays of at most 60 timestamps plus one state row |

These are logical live-row bounds, not physical PostgreSQL relation-size limits;
MVCC dead tuples and indexes require normal autovacuum. Binary bytes awaiting
cleanup and retained JSON recovery data still count against payload quotas.
Tombstones needed by recovery revisions remain until those revisions expire.

New completed mutations, new upload reservations and first state-changing aborts
have independent allowances of **60 per rolling 60 seconds**. Exact preparation
retries and repeated aborts of the same retained garbage reservation are free.
Cleanup and automatic expired/stale-ticket reclamation remain available at the
limit and do not reset any allowance. New reservations still consume their
independent allowance, so reclaiming tickets cannot enable unlimited prepare loops.
Cloud Saves RPC transactions require Read Committed isolation (the HTTP default);
higher isolation levels are rejected with `INVALID_SAVE`. Reads
and maintenance may prune history; a read can therefore return a newer generation.
The configured pending-upload limit continues to apply separately.

Client cleanup marks expired pending uploads as garbage and removes registry rows
only after Storage no longer contains the object. Operator cleanup can discover
and collect objects belonging to deleted users. Use the documented operator
Storage cleanup path; do not delete `storage.objects` rows directly. Collection
is bounded in batches of 100 registry rows; receipt/tombstone maintenance is also
batched. Accounts already above the new bounds converge through maintenance;
new writes fail closed while receipt capacity is still exceeded. The migration
does not wipe historical data to enforce the new bounds immediately.

## Interrupted uploads

Preparation binds the reservation to its generation for 24 hours. A generation
change between prepare and commit rejects the uncompleted commit with
`SAVE_CONFLICT` and marks its pending reservation as garbage. The prior live save
is untouched. The SDK keeps the caller's Blob; the offline adapter retains its
queued Blob. Abort/cleanup remains possible with current context. Reconcile
explicitly and prepare a new operation before uploading again. A completed,
covered commit retry still returns its original receipt across generation changes.

## Deleted accounts and sessions

RPCs, direct save reads and Storage authorization require an existing Auth user
whose `deleted_at` is null. Mutating operations and Storage policy checks acquire
an Auth-row SHARE lock, serializing against both hard deletion and soft-deletion
updates. Direct Data API reads check the active identity in their read-only
transaction snapshot. If the save wins the race, deletion can subsequently leave an orphaned
Storage reservation for maintenance. If deletion wins, the save is denied.
The reservation table intentionally has no Auth foreign key.

This does not introduce immediate session-sign-out revocation. JWT expiry and
Supabase Auth's existing session semantics still apply to active accounts. A
mandatory `session_id` lookup would reject supported custom JWT contexts and is
not needed for deleted-account protection. No privileged Auth data is exposed.
Supabase Storage ownership behavior varies by deployed Auth version; the pinned
local integration stack permits deletion with owned objects, so authorization
must fail closed regardless of whether Auth itself blocks a deletion.

## Upgrading existing development installations

Apply the additive module migrations and deploy the matching Edge/SDK assets
together. Existing live saves, slot revisions and recovery snapshots survive.
Old writers without generation fail explicitly. Old offline queues and persisted
account-transition writes without generation must retain their payload and require
explicit reconciliation; they are never silently upgraded into new mutations.
Legacy prepared uploads cannot commit without generation context: abort/collect
them and explicitly prepare again. Existing receipt ordering uses its historical
timestamps; new completions use durable sequence ordering.

In the TypeScript SDK, ordinary immediate saves infer context from a loaded record
or a fresh context read. Durable writes with a supplied `operationId` must also
supply `generation`. Store both with the payload before attempting the write:

```ts
const context = await game.saves.context();
const intent = {
  operationId: crypto.randomUUID(), generation: context.generation,
  expectedRevision: 0,
};
// Persist intent and payload together before sending. Retry these exact values.
await game.saves.save('progress', { level: 1 }, intent);
```

For replacement use the loaded save's generation and revision. For a conflict,
retain both copies and ask the game/application to resolve it explicitly.

The offline adapter offers `resolve(slot, json, expectedRevision)`,
`resolveBinary(slot, blob, expectedRevision)` and
`resolveDelete(slot, expectedRevision)`. Each is an explicit new intent, reads
current generation context, retains the replaced queue in local history and
rejects a concurrent change to that queue or its observed cloud generation.
Resolution does not itself send the mutation; call `sync` afterward.
For an existing account-transition journal that predates generations or conflicts
after a generation change, call `inspectAccountSwitch` with its associated
`flowId` and `restart: true`, review the current target again, then explicitly
resolve. Previous review snapshots remain recoverable.

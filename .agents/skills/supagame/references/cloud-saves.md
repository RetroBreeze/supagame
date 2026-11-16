# Cloud Saves: generations, retries and reconciliation

Read this before writing any save integration. It covers the current module
0.1.5 protocol, not historical Wiki examples that omit `generation`.

## Durable operations

Every save/delete/prepare/commit/abort/restore **wire mutation** requires an
observed `generation` string. `GET /saves` returns `{slots,generation}` even when
no slots exist; loaded saves also include generation. Store it with the player,
slot, operation UUID, expected revision, payload/Blob, schema and metadata before
sending. Treat generation as opaque; do not invent or increment it.

The TS SDK may infer context for immediate operations. Supplying `operationId`
requires also supplying `generation`. Explicitly pin `expectedPlayerId` for
persisted intents to prevent an account switch from redirecting a save.

```ts
import { createOperationId, type GameServices } from '@retrobreeze/supagame-sdk';

export async function prepareNewSave(game: GameServices) {
  const { userId } = await game.players.ensureAnonymousSession();
  const { generation } = await game.saves.context();
  return {
    slot: 'progress', data: { level: 1 },
    options: {
      operationId: createOperationId(), generation,
      expectedRevision: 0, expectedPlayerId: userId,
    },
  };
}

export async function sendPersistedSave(
  game: GameServices, intent: Awaited<ReturnType<typeof prepareNewSave>>,
) {
  // Caller durably stores the complete intent before this call, then retries it unchanged.
  return game.saves.save(intent.slot, intent.data, intent.options);
}
```

`expectedRevision: 0` is create-only within the observed generation. For replacement,
use the loaded save's revision and generation. Do not assume a missing/deleted slot
is safe to recreate with stale context. At wire level a JSON save body is:

```json
{"action":"save","generation":"<observed generation>","expectedRevision":0,"operationId":"<UUID>","schemaVersion":1,"metadata":{},"data":{"level":1}}
```

The finite exact-replay guarantee covers the **latest 3,072 completed operations
that are also less than 30 days old, per player**. At most 4,096 receipts are kept;
additional retained, unexpired receipts may replay. It is neither perpetual nor
all writes within 30 days. Covered exact retries are checked before generation
fencing; conflicting reuse of a retained ID returns `DUPLICATE_KEY_CONFLICT`.
Replay acknowledges the historical result; load again to see current state.

Pruning receipts/tombstones/reservations advances generation transactionally.
Without a receipt, stale generation returns `SAVE_CONFLICT` with current context;
missing generation returns `INVALID_SAVE`. Reads/maintenance may advance generation.
Keep the original data and intent. SDK `SaveConflictError.generation` is the
server context; `operationGeneration` is the attempted request's context.

## Offline conflict handling

1. Restore the existing local identity and queued data before showing an empty
   save. Never discard progress because refresh, network or permissions failed.
2. Retain both cloud and local versions on conflict. Read current state and ask
   the game/player to choose, merge or copy to another slot. No automatic overwrite.
3. Explicit resolution creates a **new** operation ID with the newly observed
   generation and chosen expected revision. Never attach fresh context to an old
   queued operation to make it pass.

`createOfflineSaves` is a core SDK export. Supply `{saves, store, namespace,
playerId}` with an atomic `SaveStore` and stable game/project namespace. The
identity callback returns the restored session identity, not a wire owner override.
Browser projects may use `createIndexedDbStore` from the `/browser` export.
Native apps implement equivalent durable storage using engine/platform facilities.

The adapter provides `local`, `load`, `stage`, `stageBinary`, `delete` and `sync`.
Await staging before leaving the screen. `resolve(slot, json, expectedRevision)`,
`resolveBinary(slot, blob, expectedRevision)` and `resolveDelete(slot, expectedRevision)`
are explicit new intents: they read current generation, preserve replaced queues
in local history and reject concurrent changes. Call `sync` afterward; resolution
alone does not upload. Legacy queues lacking generation stay preserved and need
explicit reconciliation. Old account-transition journals need
`inspectAccountSwitch(transition, {flowId, restart: true})`, a new review and
explicit resolution.

## Binary, limits and upgrades

Binary bytes go to the private `supagame-saves` Storage bucket with the player's
JWT. The HTTP protocol is prepare → upload immutable object → commit; use the
returned ticket/path, exact byte count and SHA-256, never upsert. SDK
`saveBinary(slot, blob, options)` and `loadBinary(slot)` implement this. Abort and
cleanup use the documented APIs, never direct `storage.objects` deletion.

Preparation binds generation for 24 hours. If it changes before an uncompleted
commit, the server returns `SAVE_CONFLICT`, marks the pending reservation garbage
and preserves the prior live save. Keep the Blob, reconcile explicitly and prepare
a new operation. A covered completed commit retry still replays across generation
changes. The SDK hashes the whole Blob in memory; do not promise streaming or
resumable uploads. Web hashing needs a secure context (`crypto.subtle`).

New completed mutations, reservations and first state-changing aborts have
separate limits of 60 per rolling 60 seconds. Exact preparation retries/repeated
aborts of retained garbage are free; cleanup doesn't reset limits. Checkpoint
rather than save every frame. Pending and retired binary bytes count until cleanup.
Backups retain up to five revisions per backed slot for 30 days; request
`backupExisting: true` where the workflow needs prior-state recovery. Restore
requires current revision/generation and creates a new backed mutation.

Upgrade database migrations and matching Edge/SDK assets together. Preserve
existing saves and local payloads; old writers without generation fail closed.
Deleted Auth users cannot use save RPCs/Storage; this is not immediate revocation
of every signed-out session. Do not claim stronger token semantics.

Authoritative details and quotas:
[Cloud Saves protocol and retention](https://github.com/RetroBreeze/supagame/blob/main/docs/guides/cloud-save-protocol.md).

# Cloud Saves

Cloud Saves stores player-owned JSON and binary progress in the developer's Supabase project. No central Supagame service, permanent account or client secret is required. Save data is client controlled: it must never authorize leaderboard changes or achievement unlocks.

## Quickstart

Use Node 24 and the matching CLI/SDK/contracts packages (0.1.2).

```sh
supagame upgrade --dry-run   # existing installations: inspect known forward-only upgrades
supagame upgrade
supagame add cloud-saves
supagame doctor
supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
supagame deploy --project-ref YOUR_PROJECT_REF
```

The final command displays the exact destination and pending migrations and asks for confirmation. Installation, upgrade, and quota configuration only stage local files. Nothing creates a bucket or changes hosted policies until the reviewed migrations are deployed. The shared API runtime currently travels with the leaderboards module; Cloud Saves installs that dependency and Core automatically. You need not create a leaderboard.

```ts
import { createGameServices, SaveConflictError } from '@supagame/sdk-ts';
const supagame = createGameServices({ supabase }); // your existing Supabase client
await supagame.players.ensureAnonymousSession(); // reuses existing accounts

const first = await supagame.saves.save('slot1', { level: 1, coins: 12 });
const loaded = await supagame.saves.load<{ level: number; coins: number }>('slot1');
await supagame.saves.save('slot1', { level: 2, coins: 20 }, {
  expectedRevision: loaded.revision,
  schemaVersion: 1,
  metadata: { label: 'Forest checkpoint' },
});
const slots = await supagame.saves.list(); // metadata only, ordered by slot name
await supagame.saves.delete('slot1');
```

Slots use 1–64 letters, digits, underscores or hyphens, beginning with a letter/digit. `cleanup` is reserved. Arbitrary finite JSON is accepted, including arrays, scalars and null. Undefined values, cycles, sparse arrays, NUL and unpaired surrogates are rejected instead of being silently changed by serialization. JSON floating-point values are allowed; leaderboard scores still require safe integers. JSON saves have no Storage round-trip.

Responses contain slot, kind, revision, schemaVersion, metadata, sizeBytes, createdAt, updatedAt, deleted and objectPath (null for JSON). Loads also contain JSON data. Metadata is a JSON object up to 4 KiB. Schema versions are positive integers defined by the game; Supagame does not migrate or interpret game data. Games must validate data and handle unsupported schema versions.

## Revisions, retries and deletion

Revision 0 is create-only. The SDK remembers the last observed revision per player and slot; without one, it uses 0. Passing `expectedRevision` explicitly is recommended for saved snapshots. Concurrent operations serialize per authenticated player, including quota accounting. A stale attempt receives HTTP 409 `SAVE_CONFLICT`, with the current record or null. It cannot silently overwrite another tab or device.

```ts
try {
  await supagame.saves.save('slot1', localData, {
    expectedRevision: loaded.revision,
    operationId: stableOperationId,
  });
} catch (error) {
  if (error instanceof SaveConflictError) {
    // Keep localData and error.current. Ask the player, or apply a game-specific
    // operation replay. Never generically merge arbitrary JSON.
    const chosen = await chooseProgress(localData, error.current);
    await supagame.saves.save('slot1', chosen, {
      expectedRevision: error.current?.revision ?? 0,
      operationId: newOperationId,
    });
  } else throw error;
}
```

Use `createOperationId()` for secure UUIDs, including HTTP LAN browsers with `getRandomValues` but no `randomUUID`. Persist the operation ID, payload and expected revision before sending. A retry must use all three unchanged. Successful operations retain fingerprinted receipts; identical retries return their original acknowledgement even after subsequent edits. Reusing a key with a different payload is `DUPLICATE_KEY_CONFLICT`. Errors carry `operationId` when one was allocated by the SDK. A retry acknowledgement does not assert that its revision is still the latest: load again to discover subsequent writes.

Deletion creates a tombstone and increments the revision. Loads return `SAVE_NOT_FOUND` and lists omit it, but its revision prevents an old offline create from resurrecting deleted data. Explicit recreation uses the tombstone revision supplied in a conflict. Original creation timestamps survive deletion/recreation.

## Binary saves

```ts
const file = new Blob([largeGameFile], { type: 'application/octet-stream' });
const saved = await supagame.saves.saveBinary('rpg-campaign', file, {
  expectedRevision: 0,
  schemaVersion: 4,
  operationId: durableUploadOperationId,
});
const restored = await supagame.saves.loadBinary('rpg-campaign');
await engine.restore(await restored.data.arrayBuffer());
await supagame.saves.delete('rpg-campaign', { expectedRevision: saved.revision });
await supagame.saves.cleanup();
```

The SDK manages bucket names, object paths and the upload protocol. Binary data goes directly to private Supabase Storage with the player's session, not through Edge JSON bodies. The HTTP API's prepare action returns an immutable upload ticket; upload through the Storage HTTP API, then commit through Supagame. This protocol is available to other language clients without PostgreSQL access.

1. **Prepare:** reserve owner/operation UUID path, exact bytes, content hash, schema, metadata and expected revision. Pending reservations count toward quotas.
2. **Upload:** create an immutable object, never upsert. Restrictive Storage policies require an unexpired reservation and bound both preflight content length and final size. No client can update these objects.
3. **Commit:** verify the object exists and matches reserved size, recheck revision and quotas, then transactionally point the slot at it and retire the old object. Client SHA-256 binds retry content; it is not proof of honest gameplay.
4. **Cleanup:** delete only retired, explicitly aborted or expired pending objects through Storage's API. Keep registry entries until physical deletion succeeds. A live committed object is never deletable by a player.

If upload or commit fails, the previous save remains readable. Retry with the same bytes/options/operation ID. Abort a failed upload with `saves.abortBinary(slot, operationId)`; this cannot abort a committed live version. Pending tickets expire after 24 hours. `saves.cleanup()` retries a bounded batch of the current player's garbage; call it after deletion/replacement or during routine synchronization. Metadata deletion is never used as a substitute for deleting Storage objects.

Binary hashing requires HTTPS or localhost (`crypto.subtle`). Standard uploads restart a failed transfer rather than resuming at a byte offset. The SDK currently reads a Blob into memory for hashing/upload, so memory usage grows with file size. The default 50 MiB limit accommodates larger saves; multi-gigabyte configurations should use a separately reviewed streaming/resumable client for the documented reservation/commit protocol. Supabase recommends resumable transfer above 6 MB: https://supabase.com/docs/guides/storage/uploads/resumable-uploads.

## Durable browser saves

The core SDK has no DOM dependency. Supply an atomic persistence adapter; the optional browser export uses IndexedDB transactions with strict durability and stores Blobs as well as JSON.

```ts
import { createOfflineSaves } from '@supagame/sdk-ts';
import { createIndexedDbStore, watchSaveConnectivity } from '@supagame/sdk-ts/browser';
const local = createOfflineSaves({
  saves: supagame.saves,
  store: createIndexedDbStore('my-game-saves'),
  namespace: 'my-game:my-project', // unique per installation/project
  playerId: async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
});
const reconnect = watchSaveConnectivity(local, {
  slots: ['slot1'], onError: showSyncIssue,
});
const cached = await local.local('slot1');
// Show cached.cloud or the latest cached.pending data immediately.
// Hydration must not replace staged progress with a blank initial state.
try { await local.load('slot1'); } catch (error) { showSyncIssue(error); }
await local.stage('slot1', gameState, { schemaVersion: 1 }); // durable before network
try { await local.sync('slot1'); } catch (error) { showSyncIssue(error); }
// local.stageBinary(slot, blob), local.loadBinary(slot), and local.delete(slot)
// use the same queue. The latest cached binary is available as entry.binary.
reconnect.dispose();
```

The identity callback must return the selected locally restored identity; never a user-controlled owner ID for HTTP requests. The SDK pins queued writes to that identity before selecting its JWT. No session means no authenticated cache access. With an expired session, an application may expose its previously restored local identity for cache access while requiring normal Auth refresh before sync. Do not silently sign in a replacement anonymous user on refresh failure.

Queues retain operation IDs and revisions across reloads. Transactions prevent tabs from losing each other's queued writes. Network, authorization, permission and server errors remain distinct and leave pending data intact. Conflicts store both the current cloud record and the pending local queue. `local.resolve(slot, chosenJson, currentRevision)` explicitly replaces the queue and archives the old queue in history. Binary conflicts can retain the Blob locally and be explicitly retried through `saveBinary` against a chosen revision or copied to a different slot. Nothing silently merges game state.

IndexedDB can be cleared by the user, browser eviction or private-mode restrictions. A failed local transaction is an error, not a successful save. Await staging before navigating away. Large offline files consume the origin's browser quota. Application-level side effects should use durable operation journals, as Vaccoin does for completed runs and purchases.

## Quotas and operations

Defaults: 10 active slots, 1 MiB JSON per slot, 50 MiB binary per slot, 100 MiB total/player and 20 pending binary reservations. Total accounting includes retired binary objects until cleanup. JSON bytes use PostgreSQL's UTF-8 JSON representation, which can differ from minified wire size. Tombstones and operation receipts are retained for permanent retry safety and require long-term capacity planning; there is currently no automatic receipt pruning or account-abuse defense.

```sh
supagame saves configure --max-slots 20 --max-json-bytes 524288 \
  --max-binary-bytes 104857600 --max-total-bytes 524288000 --dry-run
supagame saves configure --max-slots 20 --max-json-bytes 524288 \
  --max-binary-bytes 104857600 --max-total-bytes 524288000
```

This stages an additive quota/bucket migration. It never rewrites deployed migrations or deletes saves that exceed newly reduced limits. Limits may reject future writes until data is removed or quotas increased. JSON is bounded to 1 MiB; larger state belongs in binary saves. Global Supabase Storage limits can impose a lower maximum than the per-bucket setting. Doctor explicitly cannot verify those from SQL.

```sh
supagame doctor --local
supagame doctor --remote --project-ref YOUR_PROJECT_REF
supagame saves cleanup --local --dry-run
supagame saves cleanup --local
supagame saves cleanup --remote --project-ref YOUR_PROJECT_REF --dry-run
```

Doctor checks migration history, RLS, grants, function security, private bucket configuration, restrictive Storage guards and deleted-user object records. It distinguishes local configuration, verified database catalog state and unverifiable hosted/runtime settings. It does not prove application correctness or silently repair drift.

Operator cleanup handles deleted Auth users and abandoned uploads without requiring those players to reconnect. It previews up to 100 exact object paths. Hosted execution requires explicit confirmation (or separate `--allow-remote` CI consent), plus `SUPAGAME_STORAGE_ADMIN_KEY` supplied only to the operator process. Never add that credential to the game or commit it. Local cleanup discovers only the selected local fixture's credential in memory. The cleanup RPC acquires the same per-player locks as commits, rechecks liveness, deletes through Storage, then acknowledges registry removal. Failures retain recovery records. Repeat the command for more batches; scheduling it is an operator deployment choice.

## Authentication and security

Anonymous Auth users are authenticated owners. All slot operations derive identity from verified JWTs and `auth.uid()`. No payload accepts an owner ID. Players have owner-only SELECT under RLS and no direct slot/configuration/receipt writes. Definer functions have an empty search path and narrow grants. Storage insert/read/delete policies are owner scoped; restrictive guards protect the Supagame bucket even alongside unrelated permissive host policies. Unrelated buckets and Supabase configuration remain intact.

An anonymous account is tied to its persisted session. Clearing that session or changing browser/device can make saves unrecoverable. Link an email/provider identity to the existing Supabase user when the game later offers account recovery; do not create a different user and assume saves transfer. See https://supabase.com/docs/guides/auth/auth-anonymous and https://supabase.com/docs/guides/auth/auth-identity-linking. Vaccoin now provides optional Google linking and account recovery; see [accounts](accounts.md).

Public errors include `SAVE_NOT_FOUND`, `UNAUTHORIZED`, `SAVE_CONFLICT` (with current state), `SAVE_QUOTA_EXCEEDED`, `INVALID_SAVE`, `DUPLICATE_KEY_CONFLICT`, `FORBIDDEN`, and `STORAGE_UNAVAILABLE`. SDK transport failures use `NetworkError` / `NETWORK_UNAVAILABLE`; invalid local inputs use `InvalidParameterError`. Tokens and SQL details are never copied into public errors.

Storage policies protect access, not truth. Modified clients can fabricate plausible progress and cosmetic wallet balances. Leaderboards and achievements continue using their separate trusted submission/rule paths.

Successful mutations are limited to 60 per player per minute. Idempotent retries do not consume another mutation; excess new writes return `RATE_LIMITED`. Batch game events into checkpoints rather than saving every frame.

## Server revision recovery (module 0.1.3, packages 0.1.4)

Account replacements require durable backups. `save`, `delete` and binary `prepare`
accept optional `backupExisting: true`; binary `commit` uses the persisted reservation.
The previous valid JSON/binary slot is archived atomically only when the mutation commits.
Failed writes preserve it. Ordinary writes leave earlier retained backups protected.

Authenticated `POST /v1/saves/:slot` actions use the existing `sg_cloud_save` RPC:

| Request body | Response |
| --- | --- |
| `{ "action": "revisions" }` | `{revisions: [{save, archivedAt, expiresAt}]}` |
| `{ "action": "loadRevision", "revision": 1 }` | `{save}` including JSON or private binary object path |
| `{ "action": "restore", "revision": 1, "expectedRevision": 3, "operationId": "<uuid>" }` | `{save}` metadata for the new revision |

Restore always archives the current valid save. The server derives ownership from Auth,
locks the player, checks revision/quota and records a stable receipt. Retried requests
return that receipt even if the original backup has since expired. No owner override,
direct archive-table access, additional bucket or privileged game credential is used.
SDK equivalents are `listRevisions`, `loadRevision`, `loadBinaryRevision`, and
`restoreRevision`; see the [copyable recovery example](accounts.md#backups-and-recovery).

Retention: five prior backed-up revisions per slot, each expiring after 30 days. The
sixth archive prunes the oldest. Expiry is enforced at access, with lazy physical pruning.
The existing `max_slots` independently caps live slots and slots with retained history
(including deleted slots), so tiny payloads cannot accumulate unlimited backup metadata.
Archives share the existing total-byte quota; binary bytes count once per immutable object
and remain charged until physically cleaned up. JSON copies each count. Restoration
creates a new revision without copying binary bytes. Current live data never expires.
`cleanup` protects retained and restored objects; operator cleanup can reclaim expired
binary objects for inactive users. This is a bounded recovery window, not permanent history.

For an existing installation, the updated CLI retains the exact 0.1.2 asset inventory and
stages an additive upgrade:

```sh
supagame upgrade --dry-run
supagame upgrade
supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
# Review migration 20261110000306_save_revisions.sql and the Edge function update.
# Only after separately authorizing a hosted deployment:
supagame deploy --project-ref YOUR_PROJECT_REF
supagame doctor --remote --project-ref YOUR_PROJECT_REF
```

Both the migration and updated Edge validator must be deployed before the new SDK's
account replacements work. Retention does not require another hosted service or Auth
configuration change. No hosted deployment was performed as part of this implementation.

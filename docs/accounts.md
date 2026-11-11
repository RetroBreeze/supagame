# Accounts, recovery and save conflicts

Supagame uses Supabase Auth identities. Linking a provider upgrades the current player;
signing in may select another player. These are different operations. No account is
automatically merged, deleted, or assigned another user's identity.

## Configure the client

```ts
import { createClient } from '@supabase/supabase-js';
import { createGameServices } from '@supagame/sdk-ts';

const supabase = createClient(projectUrl, publishableKey, {
  auth: { flowType: 'pkce', detectSessionInUrl: false },
});
const game = createGameServices({
  supabase,
  accounts: { namespace: `my-game:${projectUrl}` },
});
```

The namespace must uniquely identify this game and Supabase project, and remain stable
across redirects. The default account store is IndexedDB, including Blob support and
atomic transactions. Non-browser applications can supply `accounts.store`, implementing
`LocalStore<unknown>` with durable, atomic read/update operations and Blob support. A
memory-only store is suitable **only for tests**. Storage failure is an error, not a
successful preparation. Session credentials stay in Supabase's own configured storage.
Use HTTPS or localhost; private HTTP LAN addresses are not supported OAuth origins.

## Guest detection and linking

```ts
await game.players.ensureAnonymousSession(); // Reuses an existing authenticated session.
const status = await game.players.getAuthStatus();
// { userId: string | null, isAnonymous: boolean, providers: string[] }
if (status.isAnonymous) {
  // Invoke only after the player clicks Link Google.
  const { url } = await game.players.linkProvider('google', {
    redirectTo: `${location.origin}/auth/callback`,
  });
  location.assign(url);
}
```

`Provider` comes from Supabase, so the API also accommodates other configured providers.
Linking is successful only after callback verification confirms the original user ID,
a permanent user, and the requested provider identity. Profiles, scores, achievements,
saves and game purchases retain their existing owner without migration. If the provider
identity is in use, `AccountError.code === 'ACCOUNT_CONFLICT'` asks the application to
offer **Sign In**, never substitutes it automatically.

`restoreSession()` verifies an existing session without creating a guest. `signOut()`
uses Supabase's local sign-out scope; it does not delete accounts or sign other devices
out. `onAuthStateChange(callback)` returns an `unsubscribe()` handle. Its callback
receives status and the Supabase Auth event, without tokens. Do not await Auth methods
inside that callback: schedule application reload/rebinding outside the Auth callback.

## Existing-account sign-in and safe transitions

Before leaving a guest, pause gameplay/autosaves and finish durable local staging. An SDK
cannot discover arbitrary game state in application memory. Supply every unsynchronized
slot (the final JSON state, binary Blob, or a `kind: 'delete'` entry):

```ts
const transition = await game.saves.prepareAccountSwitch({
  beforeSnapshot: async () => {
    await pauseAndPersistGame();
    return [{ slot: 'campaign', kind: 'json', data: currentProgress, schemaVersion: 1 }];
  },
});
const { url, flowId } = await game.players.signInWithProvider('google', {
  redirectTo: `${location.origin}/auth/callback`,
  transitionId: transition.id,
});
// Persist flowId in application storage if needed to resume the review UI later.
location.assign(url);
```

Preparation captures all existing guest slots plus supplied local slots. It does not
flush or discard pending writes. The latest supplied local state wins over the remote
version for that slot. With `createOfflineSaves`, call
`offline.prepareAccountSwitch(['campaign', 'settings'])` to capture the final pending
JSON/binary/delete operations. This pauses mutations for that identity until
`offline.resumeAfterAccountSwitch()` is explicitly called. Continue to prevent gameplay
changes after preparation. Vaccoin does this through its Workshop controller.

On a new device with no guest progress, call `signInWithProvider('google', {redirectTo})`
directly. Existing-account sign-in does not preserve the departing guest ID. It recovers
the authenticated account's own profiles, scores, achievements and saves.

## Handle the OAuth callback once, before starting game modules

```ts
const callback = await game.players.handleAuthCallback(location.href);
// Exchanges the code with Supabase's supported PKCE API; verifies the resulting user.
history.replaceState(null, '', location.pathname); // Remove the consumed code.

if (callback.transitionId) {
  const transition = await game.saves.pendingAccountSwitch();
  if (!transition || transition.id !== callback.transitionId) throw Error('Missing snapshot');
  const review = await game.saves.inspectAccountSwitch(transition, {
    flowId: callback.flowId,
  });
  showProgressChoice(review); // Target data is available only after authenticating it.
}
```

Persist `{flowId, transition}` before clearing callback parameters if the conflict UI
must resume after another reload. Flow intent lasts 15 minutes. Missing, expired,
cancelled or mismatched flows fail closed; staged saves remain. Repeated verified
callbacks do not exchange the single-use code again. Supabase owns PKCE validation,
session refresh, verifier storage and token validation. Supagame does not implement an
OAuth server or accept tokens supplied in save snapshots. Error messages omit raw
provider diagnostics and credentials. Retain the original callback URL in memory until
successful handling; do not log it.

## Resolve a save conflict

After displaying both versions and receiving the player's explicit choice:

```ts
const result = await game.saves.resolveAccountSwitch(transition, {
  strategy: 'keepGuest', // 'keepCloud', 'keepGuest', 'merge', or 'defer'
  targetPlayerId: review.targetPlayerId,
  confirmed: true,
  backupExisting: true, // Backups are mandatory; false is rejected.
});
```

- **Keep Cloud:** makes no save writes. Load the target account's current saves and
  archive/isolate any obsolete local queue before resuming gameplay. Never replay the
  guest's queued operations into this account.
- **Keep Guest:** imports the prepared guest slots into the authenticated target,
  retaining its Auth ID. Only slots in the prepared transition are affected; unrelated
  target-only slots are untouched. Guest deletes delete matching target slots, with
  revision checks. The original guest account and its server records are untouched.
- **Merge:** invokes the developer's resolver, validates the returned JSON/Blob and
  persists the chosen payload and operation ID before attempting writes.
- **Defer:** makes no save writes and retains the snapshot. The result is
  `status: 'deferred'` and `targetPlayerId` is still authenticated. Label this **Decide
  later / stay signed in**, never “Cancel account switch.” Keep gameplay paused until
  the player chooses. `cancel` is a deprecated strategy alias returning `deferred`;
  it has never signed out or restored a guest session. Neither strategy is available
  once another resolution has begun; resume or explicitly re-review that operation.

**Cancelling authentication is separate.** Cancel at the provider, or call
`await game.players.cancelAuthFlow(flowId)` before the callback exchange starts.
This invalidates the local flow only while its original session is still current;
callbacks then fail with `FLOW_CANCELLED`. It returns the verified current status.
`AUTH_IN_PROGRESS` means exchange has started; `ACCOUNT_CHANGED` means the source is no
longer the current account. Neither case claims to undo authentication. A different tab
can still change Auth independently: always observe auth state changes.

Offer **Return to guest game** only after verifying the original guest ID is still
signed in. Once Google has replaced that session, this SDK cannot restore guest Auth:
it deliberately does not keep guest refresh/access tokens. Sign-out is not guest recovery.
A save snapshot is data, not a login credential. **Keep Google progress / skip guest
import** completes the save decision, loads Google state, and retains the guest snapshot.

Results contain `{status, strategy, targetPlayerId, completedSlots}`. Replacement uses
existing caller-authenticated HTTP mutations, optimistic revisions and stable operation
IDs. Retry the **same transition and strategy** after an interrupted response. Completed
slots and server receipts prevent duplicate revisions. Multi-slot replacement is a
journaled sequence, not an all-slots database transaction; partial progress remains
recoverable. Do not silently change strategy after writes have started.

If another device changes a save, catch `SaveConflictError` and ask the player to review
again. Explicitly call `inspectAccountSwitch(transition, {flowId, restart: true})`, then
show the new metadata and obtain a new choice. Prior reviews/backups remain available;
up to eight prior reviews are retained. A deleted target slot may first report its
tombstone revision as a conflict; explicit re-review records that revision before retry.
Never automatically overwrite a newly observed revision.

## Custom merge example

```ts
await game.saves.resolveAccountSwitch(transition, {
  strategy: 'merge', targetPlayerId: review.targetPlayerId, confirmed: true,
  merge: ({ slot, guest, cloud }) => {
    if (guest?.kind !== 'json' || cloud?.kind !== 'json') {
      throw Error('This game requires an explicit binary-save choice');
    }
    const a = validateCampaign(guest.data);
    const b = validateCampaign(cloud.data);
    return {
      slot, kind: 'json', schemaVersion: 1,
      data: {
        ...b, // Explicit game policy: retain the cloud economy and equipment.
        discoveredAreas: [...new Set([...a.discoveredAreas, ...b.discoveredAreas])],
      },
    };
  },
});
```

There is no universal deep merge. The resolver receives both payloads, kind, revision,
schema version and metadata; it must return a valid `TransferSave` for the same slot.
Validation or callback failure makes no replacement writes. Preserve operation histories
when game-specific rewards or purchases depend on them. A retried transfer uses its
persisted result rather than invoking a non-deterministic resolver again.

## Backups and recovery

`getAccountSwitchRecovery(transition)` returns guest snapshots, original target versions
and prior reviews, including actual binary Blobs. Access requires the original source or
target session. A source session sees guest data only; target backups are returned only
to the target. These are player-controlled save payloads, not credentials or account
recovery keys. JSON.stringify does **not** export Blob contents: export each Blob as a
separate binary file in your application, or preserve it using the supplied durable store.
Vaccoin's Workshop recovery export is JSON because its save is JSON.

Guest snapshots and local review journals remain device-local. Browser data clearing or
device loss can remove them; export before accepting irreversible loss.
`discardAccountSwitch(transition, {acceptDataLoss: true})` only removes a completed
local transition after explicit acceptance; failed/deferred snapshots are retained.
It does not delete server revisions.

**Replaced cloud saves now also have server-side recovery.** Keep Guest and Merge send
`backupExisting: true` on JSON, binary and delete mutations. The previous valid slot is
archived in the same database transaction as replacement. Failed writes leave the old
live save and previous history recoverable. Stable operation IDs prevent duplicate
archives on retries. Ordinary saves can opt into the same flag; restoration always
archives the displaced current save. An older server rejects this flag: update its
migration and Edge function before using replacement; there is no local-only fallback.

Retention is **at most five archived revisions per slot for 30 days from each archive**.
A sixth archive removes the oldest; reads/cleanup prune expired entries. Active slot
contents never expire. JSON backups and all physical binary objects count against the
existing per-player `max_total_bytes` quota (100 MiB default); per-save and active-slot
limits still apply. The existing `max_slots` also independently caps the number of slots
with retained history, including deleted slots, bounding metadata for tiny payloads. Binary backups reference immutable objects in the existing private
bucket, without uploading a duplicate. Cleanup protects every retained reference and
the current restored object. Expired/unreferenced bytes become garbage and remain charged
until `saves.cleanup()` or operator cleanup removes them through Storage. Expiration is
lazy, with no new scheduler: inactive JSON rows may physically remain until the next save
request; they cannot be listed/restored after expiry. Operator cleanup also reclaims
expired binary backups for inactive users. Do not rely on retention beyond these limits.
A quota error stops replacement; clean eligible garbage or have the operator review quotas.

Authenticate the target on any device to inspect/restore its backups. No transition
journal or guest credential is required:

```ts
const owner = await game.players.getAuthStatus();
const revisions = await game.saves.listRevisions('slot1');
// Each item: {save: SaveRecord, archivedAt, expiresAt}; newest first, no JSON payload.
const selected = revisions[0]; // Present metadata; let the player explicitly choose.
if (!selected) throw Error('No retained backup');
const oldJson = selected.save.kind === 'json'
  ? await game.saves.loadRevision('slot1', selected.save.revision)
  : undefined;
// Optional binary preview/download, bounded before fetching:
// await game.saves.loadBinaryRevision('slot1', selected.save.revision, {maxBytes: 8 * 1024 * 1024});
const current = await game.saves.load('slot1');
// Show what will be replaced and ask for consent before this call.
const operationId = crypto.randomUUID(); // Persist with the request if retrying after reload.
await game.saves.restoreRevision('slot1', selected.save.revision, {
  expectedRevision: current.revision,
  expectedPlayerId: owner.userId!,
  operationId,
});
```

Restore uses the retained server payload for JSON or binary; it creates a new monotonically
increasing revision, with the same CAS/receipt rules as replacement. Retry the identical
request after a lost response. A deleted slot's tombstone revision comes in
`SaveConflictError.current`; review it and obtain consent before retrying against it.
Expired/missing revisions return `SAVE_NOT_FOUND`. Restore never changes scores,
achievements or identities. No API accepts a different owner's ID. See
[Cloud Saves](cloud-saves.md) for raw HTTP actions and deployment steps.

Existing device-local backups from older releases are not retroactively uploaded.
An interrupted operation started with an older SDK may need explicit re-review with a
new operation ID if its old receipt conflicts with the new backup-required request.
Do not erase its local journal or assume the previous write gained server protection.

Transfers are sequential and bounded: 64 MiB per binary object, 128 MiB combined guest
and current target payloads, 1 MiB JSON and 4 KiB metadata. Large source files are rejected
before download based on trusted save metadata, and downloaded sizes are checked again.
Merged payloads are bounded too. Oversized saves/storage quota failures stop preparation
or replacement with the source and existing cloud state preserved. Arbitrarily large
binary transfer requires a separate resumable server streaming design; it is not silently
skipped or stuffed into localStorage.

## Identity changes and security

SDK authenticated responses are discarded if the session changes during a request.
Save revision caches and offline queues are keyed by user identity. Live leaderboard
channels detach/rebind on account changes and refresh authentication on token refresh;
achievement polling hydrates the new user's unlocks without replaying historical toasts.
Games must also clear their own runtime state and notifications. Same-ID linking should
preserve state and pending operations. Vaccoin reinitializes its runtime on genuine user
changes, and namespaces Workshop, display names and personal bests by project/user.

Save replacement does **not** migrate leaderboards, achievement ownership, identities or
server-authoritative progression. Never accept a save as evidence of scores/unlocks.
Modified clients can fabricate plausible game data. Cross-account migration of trusted
server records is outside this capability. No privileged credentials belong in clients.

## Google and CLI setup

Google credentials must be created by the developer. Following the
[official Google provider guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-google):

1. In Google Cloud, select/create a project, configure Google Auth Platform branding,
   audience and test users if the consent screen is in testing mode.
2. Create an OAuth client with application type **Web application**. Add the app's
   HTTPS origin and any localhost development origins as authorized JavaScript origins.
3. Set the authorized redirect URI to
   `https://ttwppnsnxcighfcesxhf.supabase.co/auth/v1/callback` for the specified hosted
   project. For another project, use its own Auth callback. This is distinct from the
   application's callback URL.
4. Keep Client ID/Client Secret in the developer environment or set them in Supabase's
   Google provider settings. Never add them to Vite variables or source control.
5. Enable manual identity linking and configure application callback URLs. The CLI adds
   an exact path plus a query-only glob (`https://game.example/auth/callback\?**`) for
   `sg_flow`/Supabase PKCE flow IDs. It does not wildcard hosts or unrelated paths.

Local configuration (no hosted writes):

```sh
supagame auth configure --local --enable-google \
  --redirect http://localhost:5173/ --redirect https://game.example/
supagame auth doctor --local
```

This preserves other TOML values and stores `env(GOOGLE_CLIENT_ID)` and
`env(GOOGLE_CLIENT_SECRET)` references. Supply local environment values and restart the
local stack. Real Google localhost OAuth also needs the local Supabase Auth callback
registered with Google; local application and Auth API ports are different.

Hosted read-only preview/diagnostics (requires a developer Management API token in
`SUPABASE_ACCESS_TOKEN`):

```sh
supagame auth doctor --remote --project-ref ttwppnsnxcighfcesxhf \
  --redirect http://localhost:5173/ --redirect https://game.example/
supagame auth configure --remote --project-ref ttwppnsnxcighfcesxhf \
  --enable-google --redirect http://localhost:5173/ \
  --redirect https://game.example/ --dry-run
```

When separately authorized, rerun configuration without `--dry-run`, inspect the exact
project and patch, and type the requested `auth <project-ref>` confirmation. Noninteractive
writes require the explicit `--allow-remote` flag. Existing redirects are unioned; other
Auth settings are preserved. `--site-url` changes the site URL only when explicitly given.
Credentials are passed only in the HTTPS request body and never printed. The implementation
uses the documented [Auth configuration Management API](https://supabase.com/docs/reference/api/v1-update-auth-service-config),
not a guessed endpoint or broad config push. A fresh read detects intervening changes;
that API does not provide atomic compare-and-swap, so avoid concurrent Auth administration.

`supagame config origins add` manages Edge Function CORS. `supagame auth configure`
manages Supabase Auth redirects. Neither substitutes for the other. `auth doctor` can
verify provider enablement/settings, but cannot prove that Google credentials or consent
screen settings work. No hosted configuration was changed while implementing this feature.

## Real Google smoke test

Use HTTPS or localhost and a disposable browser profile/test Google account. Play as a
guest, record its user ID and Workshop state, link Google and confirm the ID and state
stay unchanged. On a second browser/device, sign in and confirm recovery. Create a second
guest with distinct progress, sign into the first Google account, and exercise each
resolution with explicit consent. Check cancellation, blocked storage and callback
reloads. Use synthetic players; do not overwrite real progress. Automated tests mock
Google OAuth; local integration tests use real Supabase Auth/RLS/storage with synthetic
accounts. They do not certify a real Google round trip.

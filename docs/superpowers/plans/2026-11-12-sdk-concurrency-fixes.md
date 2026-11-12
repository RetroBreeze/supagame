# SDK identity and concurrency corrections

Scope: all four second-review defects against 22490de, plus the requested SDK
boundary audit. No publication, package rename, or removal of private:true.
Preserve the pre-existing documentation edits. Execute inline without subagents.

## Shared causes and implementation decisions

The original identity verification compared snapshots taken before asynchronous
work. Local storage and Auth calls did not share the HTTP transport's final
check. Introduce a common session identity check, with an Auth lifecycle epoch
so observed switch-away-and-back events also invalidate older work. Token refresh
for the same user remains valid. Check before side effects and after awaited
results, including failures containing private data. Offline clients expose only
an asynchronous playerId getter: check before/after I/O and keep writes scoped to
the captured player's key; do not claim atomicity between Auth and IndexedDB.

Offline acknowledgments must match the pending operation ID and expected
revision. Apply the same condition to conflicts. Hydration must not overwrite
newer acknowledged state or install stale binary bytes. LocalStore.update remains
the atomic cross-client compare-and-update boundary; no new store API is needed.

Live refreshes request cancellation through both transports. A timeout reports
failure and aborts, but retains the concurrency slot until both underlying reads
settle, even if cancellation is ignored. Reconnection and replacement subscriptions
share this bound for a Supabase client/board. Disposal suppresses all results and
callbacks. A permanently stuck transport can block further snapshots; this is the
necessary tradeoff for a real bound without transport cooperation.

## Execution and permanent tests

1. Add failing tests for recovery during Auth verification; pending offline reads
   and writes during switches; stale shared-store conflicts; repeated live
   timeouts under sustained hints in both transports.
2. Audit auth.ts, client.ts, players.ts, leaderboards.ts, saves.ts, accounts.ts,
   account-saves.ts, offline-saves.ts, achievements.ts, live.ts, indexeddb.ts and
   browser notification/connectivity helpers. Add focused cases for each newly
   found boundary gap before fixing it.
3. Implement shared identity validation and guarded account recovery/transfer I/O.
4. Make offline cache/queue results conditional and identity-checked, testing two
   clients with a shared atomic store and delayed storage completion.
5. Implement cancellation and bounded live reads; test reconnection, disposal,
   replacement, cooperative/ineffective abort and progress after eventual settle.
6. Run Node 24 build, unit/SDK, Edge, typecheck, lint, contracts, database,
   CLI/database, HTTP/SDK integration, fresh-source packaging and end-to-end suites.
   Check Vaccoin with isolated new tarballs. Review the diff and commit only these
   fixes/tests/docs after successful verification.

## Audit and verification record

### Reproduction and root causes

The initial regression run against the pre-fix implementation at `22490de`
failed all 14 cases in the first identity/offline/live test batch. It confirmed:

1. A delayed `getUser(A)` was accepted after `getSession()` changed to B.
   Account recovery then returned A's journal under B. Authentication of a token
   was being confused with validation that its owner was still active.
2. `offline.sync()` checked the player before `store.read`, then returned an
   empty queue's cached cloud data or threw its cached conflict without checking
   again. A delayed read exposed A's data after switching to B.
3. A delayed sync conflict was installed unconditionally after another client
   replaced the pending operation and acknowledged revision 4. Revision 3 then
   blocked a newer queue. Successful acknowledgments already checked operation
   identity, but the error path did not.
4. A live timeout released `busy` while its two HTTP requests remained pending.
   Sustained broadcasts created eight requests within 33 seconds in both
   transports. `Promise.race` limited waiting time, not underlying concurrency.

Tests are permanent in `tests/sdk/identity-boundaries.test.ts`,
`offline-concurrency.test.ts`, `offline-indexeddb.test.ts` and
`live-concurrency.test.ts`. Additional audit reproductions covered stale hydration,
revision cache regression, concurrent resolution, provider flow persistence,
callback identity, notification queues and disposal. Each newly discovered defect
was observed failing before its fix. Final review also caught a joining caller
looking up a transition promise after the identity check had allowed that promise
to finish and be removed; joining now captures the promise before awaiting.

### SDK audit coverage

| Component / operations | Boundary and resulting guarantee |
| --- | --- |
| Auth session acquisition, refresh, anonymous initialization, account verification | Capture an immutable session and shared Auth epoch. Check identity around verification and pending results; preserve same-user token refresh. Observed sign-out or switch-away-and-back invalidates older scopes. |
| HTTP transport, profiles, leaderboard reads/submission retry | Both custom fetch and Supabase Functions validate protected requests before dispatch and after success/error I/O. Identity loss takes precedence over private conflict payloads and network failures. Retry remains pinned to the original scope. Public leaderboard reads have no private session to guard. |
| JSON saves, lists, revision reads/restores/deletes | Keep original player scope through the response. Revision cache is per player/slot and monotonic under out-of-order responses. |
| Binary prepare/upload/commit/download/abort/cleanup | Guard nested save calls, Storage I/O and asynchronous byte reads before upload. Validate returned paths. Cleanup after abort remains scoped to the initiating account. Hashing has no side effect; the following transport validates identity before dispatch. |
| OAuth begin/cancel/callback, account status | Guard Auth verification and flow storage. No provider request starts after a detected switch during persistence. Code exchange intentionally changes identity; its returned player must match the newly verified scope before receipt persistence or return. |
| Account transition prepare/inspect/resolve/recovery/discard | Hold the initiating scope through journal I/O, game callbacks and save I/O. Recheck the observed epoch inside atomic journal updates. Conflicts require the same journal generation and unfinished operation/revision. Discard validates the completed journal generation. Joining callers validate their own scope around the captured shared promise. |
| Offline local/load/stage/delete/resolve/sync, including binary operations | Capture a player-specific storage key. Check the player before and after asynchronous storage/network work and on errors. Delayed results cannot be returned under a different player. Use atomic queue comparisons described below. |
| Offline transition preparation/resume | Drain the instance's active syncs; pause its writers and recheck pause inside transactions. Read captured source keys and validate the source again at the save snapshot boundary. Resume changes only the returned player's pause state. |
| IndexedDB and custom LocalStore | IndexedDB readwrite transactions already serialize cross-tab updates. Preserve that implementation; custom stores must honor the existing atomic `update` contract. Test actual IndexedDB from two Chromium tabs as well as two clients sharing a deterministic atomic store. |
| Achievement reads/polling/notification queue | Validate private results. Account changes clear queued notifications and reset the silent hydration baseline; token refresh for the same player preserves it. Suppress delayed poll errors after unsubscribe/disposal. |
| Live snapshots, connection/Auth callbacks, disposal | Request cancellation, reject stale generations, retain the request slot until both reads settle, and share the bound across replacement subscriptions. Account changes reset personal rank baselines. |
| Browser connectivity helper, validators, value helpers | Connectivity callbacks carry no account data; offline methods apply their own scopes. Synchronous validation/value helpers introduce no asynchronous identity boundary. |

### Concurrency guarantees and limits

- Auth-backed operations validate the captured player and an observed lifecycle
  epoch across asynchronous work. The epoch is shared by SDK instances using the
  same Auth client. Public signatures and supported transports are unchanged.
  Minimal existing Auth adapters without `onAuthStateChange` remain usable (as
  required by Vaccoin); they validate active session IDs, but cannot detect a
  switch-away-and-back that occurs entirely between checks. Their achievement
  queues reset when polling observes a changed user, rather than immediately on
  an event the adapter does not expose.
- Offline storage remains keyed by `[namespace, player, slot]`. The public offline
  interface supplies only an asynchronous `playerId()` getter, so it can detect
  identity differences at check boundaries, **not** an unobserved A → B → A change
  entirely between checks. Stronger guarantees for custom providers would require
  a new identity-generation API; none is introduced here.
- Auth changes and local database transactions are not one atomic system. An
  already dispatched write may finish under its original player's key. Its result
  is withheld if the identity changes; it is never redirected to the new key.
  Similarly, a server write already sent with the original JWT cannot be rolled
  back by client-side identity validation. Retry using the original operation ID
  when recovering an uncertain outcome under that account.
- Offline acknowledgments and conflicts update state only if both the pending
  operation ID and expected revision still match. Cloud hydration never replaces
  a higher known cloud/conflict revision or pairs obsolete binary bytes with it.
  Explicit resolution compares the observed queue IDs/revisions and cloud/conflict
  revisions inside `LocalStore.update`; concurrent edits cause a conflict instead
  of silently replacing newer work. Applications must not reuse operation IDs for
  different payloads and custom stores must provide atomic cross-client updates.
- Transition pause/drain is per offline instance. Applications coordinating
  account transitions across multiple writers must pause those writers too.
  `pendingAccountSwitch()` intentionally exposes only transition metadata needed
  after sign-in; private backup reads require an authenticated source/target scope.
- At most **one top/personal request pair per Supabase client object and board**
  remains underlying live snapshot work, even across subscription replacements.
  Timeout, disconnect, account change and disposal request cancellation through
  both transports. No new pair starts until both previous reads settle. Broadcasts
  coalesce into trailing work instead of invalidating an otherwise useful snapshot.
- A transport that ignores cancellation and never settles deliberately blocks
  further snapshots for that client/board. Timeout reports once for that stalled
  pair; it cannot both release the slot and preserve the request bound. Other
  boards and independent Supabase clients have independent bounds. Disposal
  suppresses callbacks, but cannot force an uncooperative transport to release its
  own resources. Cooperative cancellation, repeated timeouts, reconnection,
  account changes and replacement/disposal are tested under sustained broadcasts.
- Achievement queues created from this SDK's achievements object reset on identity
  change. A custom object implementing only `onUnlocked` exposes no Auth context;
  its owner must clear/dispose its queue when switching accounts.

No backend migration, public contract, package name/version, dependency or
`private:true` field changed. No hosted mutation or npm publication was performed.
Pre-existing documentation edits are outside this commit.

### Verification

Verification uses Node.js **24.22.2**, pnpm 12.18.0, Deno 2.9.6 and local
Supabase CLI 3.0.0. No production credentials or hosted mutations are needed.

The first complete verification run passed. Final audit tests then exposed and
corrected the joining-promise/network-error edge cases. A new live test initially
failed typechecking because its optional signal type omitted `undefined`; that
fixture type was corrected and the checks passed. Isolated Vaccoin verification
then reproduced three failures from its minimal Auth adapter lacking an event
subscription method. The SDK now preserves that adapter, with a permanent test
and the explicit fallback guarantee above. Results after rerunning with the compatibility correction:


| Command | Result |
| --- | --- |
| `node --version` | `v24.22.2`; all Node commands below used this runtime. |
| `pnpm build` | Pass for contracts, CLI, SDK and browser demo. |
| `pnpm test` | 510 tests passed, including the complete 204-test SDK suite and real two-tab IndexedDB regression. |
| `pnpm test:edge` | 84 passed. |
| `pnpm typecheck` | Pass, including workspace TypeScript and Deno Edge checks. |
| `pnpm lint` | Pass, including Edge lint/format checks. |
| `pnpm contracts:check` | Pass; OpenAPI types and SDK validators remain synchronized. |
| `pnpm test:db` | 809 SQL assertions, 2 Admin/probe tests and 21 concurrency tests passed against local PostgreSQL. |
| `pnpm test:cli:db` | 30 passed; generated achievement/leaderboard migrations executed against PostgreSQL, including delimiter-bearing text. |
| `pnpm test:edge:integration` | 1 integration scenario / 13 steps passed against local Auth/Edge/PostgREST/RLS. |
| `pnpm test:sdk:integration` | 11 passed. |
| `pnpm test:packages` | Pass: a fresh source clone starts without dist directories, packs via build hooks, and installs CLI/contracts/SDK in an isolated consumer. Also rejects missing artifacts and excludes stale build output. |
| `pnpm test:e2e` | 15 passed: packaged installation, SDK/raw HTTP, browser persistence, private database broadcasts, Admin and dashboard operator workflows. |
| Vaccoin isolated consumer | `npm ci --ignore-scripts --no-audit --no-fund`, `npm test` (242), `npm run build`, and packaged `supagame --help` passed with current CLI/contracts/SDK tarballs. Only the temporary clone's vendor archives and lockfile integrities changed. The real Vaccoin checkout remains untouched. |
| `git diff --cached --check` | Pass. |

Vaccoin verification here covers its complete unit suite, typecheck, production
bundle and installed CLI. Its optional mocked live-browser scenario was not
rerun for this patch: an earlier comparison timed out at the initial snapshot
with both the original and fixed packages in the synthetic environment. No
hosted Vaccoin or OAuth provider validation is claimed. Supagame's own packaged
browser/Realtime end-to-end checks exercise the local stack.

Local evidence logs (temporary files, not committed):
`/tmp/supagame-concurrency-red.log`,
`/tmp/supagame-concurrency-release-verification.log`, and
`/tmp/supagame-concurrency-vaccoin-final.log`.

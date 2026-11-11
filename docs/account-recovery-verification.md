# Account cancellation and server recovery review

Follow-up to Supagame `30a12cb` and Vaccoin `6567a48`, tested locally on Node
**24.22.2**. Private packages are **0.1.4**, module inventory **0.1.3**.
No hosted Supabase settings, player accounts, Google credentials, pushes or publications
were changed. Existing tracked Vaccoin edits were compared byte-for-byte with the
pre-task diff and excluded from the staged commit.

## Delivered behavior

- `players.cancelAuthFlow(flowId)` invalidates a pending flow only before exchange and
  while the original account is still current. It never restores copied credentials.
- `resolveAccountSwitch(..., {strategy: 'defer', ...})` explicitly leaves Google signed
  in and preserves the guest snapshot. The old `cancel` alias returns `deferred` too.
  Vaccoin distinguishes this from provider cancellation/returning to the verified guest,
  and from keeping Google while declining guest import. Deferred decisions survive reload.
- Transition save/delete/binary mutations require transactional server backups. JSON and
  immutable binary data can be listed/read/restored from another authenticated device,
  without the original browser's journal. Restore uses CAS and stable operation receipts,
  and backs up the displaced current save. No identity, score or achievement migration.
- Retention: five revisions per slot for up to 30 days. Existing total-byte and slot
  limits apply; `max_slots` independently caps slots with retained history, including
  deleted slots. Cleanup protects retained/live binary references and reclaims eligible
  objects through Storage. The CLI stages an additive upgrade from the exact old assets.

## Verification results

| Command/check | Result |
| --- | --- |
| `pnpm test` | PASS: 422 tests in 28 files |
| `pnpm test:db` | PASS: 809 assertions in 11 SQL files, then 21 concurrency tests |
| New recovery SQL file | PASS: 42 assertions covering JSON/binary backup and restore, failed uploads, retry receipts, quotas, retention, expiry, tombstones and cross-owner denial |
| `pnpm test:cli:db` | PASS: 28 tests, including actual local doctor/catalog checks |
| `pnpm test:edge` | PASS: 84 tests |
| `pnpm test:edge:integration` | PASS: 1 suite, 13 steps |
| `pnpm test:sdk:integration` | PASS: 11 tests; real local Auth/RLS/Storage, fresh-instance JSON/binary recovery and restore |
| `pnpm test:packages` | PASS: 1 isolated installation test, consumer typecheck and browser bundle |
| `pnpm test:e2e` | PASS: 12 tests, fresh packaged CLI installation, local backend, SDK/raw HTTP, backup restoration and Chromium |
| `pnpm typecheck`, `pnpm lint`, `pnpm contracts:check` | PASS |
| `pnpm build` | PASS: packages and browser example |
| Vaccoin `npm test` | PASS: 132 tests in 19 files, including existing user edits |
| Vaccoin `npm run build` | PASS; existing Vite large-chunk warning remains |
| Vaccoin isolated staged snapshot | PASS: 122 tests and production build, excluding pre-existing user edits |
| `scripts/accounts-browser-test.mjs` | PASS: desktop and touch/mobile guest account controls |
| `scripts/accounts-oauth-browser-test.mjs` | PASS: six full-redirect scenarios—link, Keep Google, Keep Guest, merge, defer across reload, provider cancellation |
| Package contents | Fresh tarballs compared byte-for-byte with build output and installed files; lockfile SHA-512 integrity verified |

Browser tests used the task-owned Vite server on port 5174, with backend and Realtime
requests mocked. Desktop/mobile screenshots were inspected, including the signed-in
state, deferred decision and replacement confirmation. Google OAuth itself was mocked;
local integration exercised real synthetic Supabase sessions and Storage. No real Google
round trip was performed.

Regression tests were observed failing before fixes. Initial verification also exposed
outdated typed SDK mocks and orphan registry rows for already-removed synthetic files;
the mocks and test cleanup acknowledgement were corrected. Final checks passed.

## Deployment and limits

Before real hosted testing, review/stage `supagame upgrade`, then separately authorize
deployment of **20261110000306_save_revisions.sql** and the updated **supagame Edge
function** to `ttwppnsnxcighfcesxhf`. SDK installation alone is insufficient; older
servers reject backup-required writes. No new bucket, scheduler, Auth setting or Google
credential is required by this follow-up. Existing Google/provider/redirect setup remains
necessary, as documented in [accounts](accounts.md).

The original guest cannot be authenticated again once its session is gone; snapshots
carry data, not credentials. Guest snapshots remain device-local and must be exported
before clearing browser storage. Server retention is bounded, with lazy expiry/physical
cleanup. Old local-only backups are not retroactively uploaded. Multi-slot imports remain
journaled per-slot transactions, not an atomic whole-account rollback. Vaccoin has no
in-game revision-history browser; explicit server restoration is available through the
SDK and documented examples. Quotas can safely reject replacement or restoration.

For a real smoke test after approved deployment, use disposable Google/guest accounts:
record the guest ID, cancel at the provider and confirm the same guest resumes; sign in to
an existing Google account, defer/reload and verify Google remains signed in; then replace
or merge with consent. In another signed-in browser, list and restore the prior revision
with the current revision number, and verify another player cannot read that backup.

# Optional Admin (CLI first)

Admin is for trusted Supabase project operators. Its optional local dashboard installs no hosted service or
public administrative API. Use Node 24 and Supabase CLI 3.0.0 with your existing
Supabase login (or existing supported CLI environment credentials). Never put
operator credentials in a game bundle, browser, repository or shared log.

## Installation and upgrade

```sh
supagame upgrade --dry-run
supagame upgrade
supagame add admin --dry-run
supagame add admin
supagame deploy --dry-run --project-ref abcdefghijklmnopqrst
```

Staging is local only. Actual hosted deployment is a separate explicitly
confirmed `supagame deploy --project-ref ...` operation. Admin requires core and
leaderboards; installation includes those dependencies. Existing installations
must upgrade to module templates 0.1.4 before adding Admin. Historical migrations
are preserved. No reset, moderation or restriction runs during installation.

Forward migrations:

- `20261111000100_admin.sql`: optional schema, event IDs/generations/moderation,
  restriction and permission tables, audit ledger, transactional operator
  function, submission checks and generation-aware read functions.
- `20261111000200_live_admin_reads.sql`: optional Live Leaderboards upgrade;
  receive authorization follows board RLS so disabled Admin boards remain
  subscribable. Without Admin, disabled boards remain invisible as before.

## Commands

Operational CLI commands require `--local` or `--remote --project-ref <exact-ref>`.
The dashboard uses `--local` or `--remote`, pinning the configured reference at startup.
Hosted references must agree with the manifest and existing link metadata.
The following examples target a local test installation; substitute
`--remote --project-ref abcdefghijklmnopqrst` for a hosted project.

```sh
supagame admin doctor --local
supagame admin leaderboard list --local
supagame admin leaderboard inspect vaccoin --local
supagame admin leaderboard inspect vaccoin --generation 1 --local
supagame admin leaderboard reset vaccoin --local --dry-run
supagame admin leaderboard reset vaccoin --local --reason "Start a new competition"
supagame admin leaderboard disable vaccoin --local --reason "Pause submissions"
supagame admin leaderboard enable vaccoin --local --reason "Resume competition"
supagame admin score inspect SCORE_UUID --local
supagame admin score hide SCORE_UUID --local --reason "Invalid run"
supagame admin score restore SCORE_UUID --local --reason "Appeal accepted"
supagame admin player inspect PLAYER_UUID --local
supagame admin player restrict PLAYER_UUID --local --reason "Submission abuse"
supagame admin player reinstate PLAYER_UUID --local --reason "Restriction reviewed"
supagame admin audit list --local
```

All modifying commands support `--dry-run`. These run only read-only database
queries and do not prompt. Real changes require a nonempty reason and typing the
specified action, target and destination. For explicit unattended authorization,
use `--yes` locally or `--allow-remote` remotely. Neither flag authorizes another
project. Read commands support `--json` (JSON rows without the destination label).
Errors exit 1; success exits 0. Raw subprocess errors are withheld to protect
credentials. Doctor is read-only and exits unsuccessfully on failed checks.

The preview prints an operation UUID and target revision. Save both before
retrying an uncertain operation:

```sh
supagame admin leaderboard reset vaccoin --local --yes \
  --reason "Start a new competition" \
  --operation-id 90000000-0000-4000-8000-000000000001 \
  --expected-revision 0
```

A retry must use the original UUID, revision, action, target and reason. The
server returns the original result without another mutation or audit record.
A different operation against a stale administrative revision fails. After a
network failure inspect audit history before retrying; never assume a missing
response means the transaction failed.

## Behavior and reversibility

Reset advances the generation atomically and clears only the derived current
best-score projection. All accepted events remain in private history. New
submissions start fresh; accepted retries return their original receipts without
writing again. Old cursors are rejected with `INVALID_CURSOR`; reload the first
page after a reset. There is no automatic generation rollback command.

Score IDs are UUIDs assigned to retained accepted submission events, including
non-improvements. Inspection lists the latest 100 events in a selected generation
and counts all generations. These are accepted events, not a complete history of
rejected requests. Hide excludes an event and recalculates that player's best
from other visible events in the active generation. Restore reverses that event's
moderation; a historical restore cannot enter the current generation. New valid
submissions can establish a new best without unhiding a moderated event.

Disable/enable is reversible and preserves readable rankings. Restrict/reinstate
is reversible and affects only score submission, including retries while
restricted (`PLAYER_RESTRICTED`, HTTP 403). It does not sign players out, alter
profiles, delete saves or revoke achievements. Anonymous-account restrictions
cannot prevent someone creating a new anonymous identity.

Live subscribers receive board-only invalidation hints and refresh through the
normal API. No audit details, reasons, submission keys or row images are broadcast.

## Trust boundaries and bootstrap

The CLI uses the existing isolated Supabase CLI database transport, not a game
JWT or browser secret. Private operator functions execute with invoker rights,
allow only trusted database operator roles, and have all PUBLIC, anon,
authenticated and service_role execution revoked. Other private helpers have
fixed empty search paths and similarly restricted grants. Private tables use RLS
without player policies and have player/service-role grants revoked.

`sg_private.admin_permissions` stores the six granular permission names:
`leaderboards.read`, `leaderboards.manage`, `scores.moderate`, `players.restrict`,
`admins.manage`, and `audit.read`. The private `admin_has_permission` helper checks
both the assignment and the authoritative Auth identity, rejecting anonymous
identities. Deleting an assignment revokes it immediately. Players cannot read or
write assignments, and cannot call the helper. No editable metadata authorizes
anything. The database owner can recover/bootstrap assignments using a trusted
SQL connection; assignments do **not** grant access to the operator CLI functions.

A future delegated endpoint must derive the user from verified authentication,
check the required private permission, and invoke a separately authorized narrow
operation. It must never forward operator credentials. A local dashboard can
reuse `lib/admin.ts` operation/inspection builders and shared contracts behind a
local server; prompts and credentials stay outside browser JavaScript.

The append-only operation API records operation ID, database actor, action,
target, reason, time, outcome and before/after metadata. It offers no audit edit
or delete operation. Successful transactions are audited atomically; rejected or
rolled-back requests do not create committed audit rows. The actor is the
trusted database session role, not a verified personal identity of the human
holding the Supabase CLI credential. Use project operator access logs for that
correlation. As with all project-owned SQL, the database owner can bypass or
repair schema protections; this is not a tamper-proof log against the owner.
Audit listing returns the latest 100 operations. Do not put secrets in reasons.

## Local dashboard

CLI 0.1.5 adds `supagame admin dashboard --remote` (or `--local`) with `--workdir`
and `--port`. It is a bundled loopback interface over the existing Admin service,
with a private launch code, explicit previews and confirmations. No new migration
or hosted deployment is needed when Admin 0.1.4 is already installed. See
[Admin Dashboard](admin-dashboard.md) for setup, SSH access, security and limits.

# Supagame v0.1.0 remediation verification

Work began against the existing `fix/npm-readiness` working tree on 2026-11-16.
This report covers the five requested findings and the explicitly approved
pre-release Cloud Saves protocol change. Verification is local; no hosted
Supabase deployment, npm publication, tag, push or destructive reset is authorized
or performed by this work.

**Assessment: GO for the verified v0.1.0 working-tree candidate.** All five
findings are resolved; publication and hosted deployment still require separate
authorization. This assessment includes the preserved pre-existing npm-tooling
changes in the tested working tree, not just the remediation commits in isolation.

## 1. Findings

| Finding | Final status |
| --- | --- |
| Deleted identities retain Cloud Saves access | Resolved; retained-JWT and deletion-race regressions pass |
| Unbounded receipts and tombstones | Resolved through approved generation protocol and bounded retention |
| Prepare/abort throttle bypass | Resolved; independent serialized allowances and free exact retries |
| Missing FK indexes | Resolved with measured, nonredundant indexes |
| Deep pagination ranking work | Improved and verified; remaining exact-count complexity documented |

### Deleted Auth users — confirmed high severity

The previous RPC checked JWT identity, while the intentionally orphanable binary
registry and Storage helpers did not require an active Auth row. The original
real-JWT regression reproduced both an unauthorized post-deletion reservation
and an HTTP 200 Storage upload. These were separately observed; reservation
creation alone was not treated as upload evidence.

Cloud Saves migration 008 adds an active-identity check and Auth-row SHARE lock
before the RPC's user advisory lock. Hard deletion and soft-deletion updates
serialize against mutations and Storage policy checks. Migration 010 adds a
restrictive direct-save SELECT policy. Regression testing then exposed a
PostgREST compatibility defect: direct table GETs use read-only transactions and
cannot acquire SHARE locks. Migration 012 gives that policy a caller-only,
snapshot-based existence check. RPC and Storage locks remain in place. No Auth
foreign key was added to the orphanable registry; operator garbage collection
remains available. Helpers have fixed empty search paths and narrow grants.

The pinned local Auth/Storage build permits hard and soft deletion even with
owned objects. Tests verify actual `owner_id`, retained JWT rejection and retained
bytes/registry for cleanup. This qualifies upstream guidance suggesting owned
objects can prevent user deletion: Supagame must enforce its own checks regardless.
Session-row existence was considered but not made mandatory: it would exclude
supported custom JWT contexts and is unnecessary for deleted-user revocation.
Active-user sign-out continues to follow JWT lifetime/session semantics. Supabase
explains why issued JWTs survive deletion and describes optional session-row
validation in its [user management](https://supabase.com/docs/guides/auth/managing-user-data)
and [session documentation](https://supabase.com/docs/guides/auth/sessions).

Evidence: `tests/db/cloud-saves-authorization.test.sql`,
`tests/db/save-security-concurrency.test.ts`,
`tests/sdk/deleted-saves.integration.ts`, existing Cloud Saves lifecycle/security
and cleanup integration suites. Races cover deletion first and reservation first,
for both hard and soft deletion. The surviving orphan is intentional when the
save transaction wins the race.

### Unbounded receipts/tombstones — confirmed; approved protocol change

Indefinite replay and stale-create protection cannot both be preserved while
forgetting unlimited distinct operation/slot names under the old protocol.
The user approved generation fencing and finite replay before implementation.
Migration 009 introduces bounded per-player state and transactional maintenance;
011 orders new completions with a durable per-player sequence rather than relying
on timestamps/UUIDs. A backwards-clock regression failed before 011 and passed
after it. Legacy rows retain their historical timestamp ordering.

The bounds are 4,096 receipts, 1,024 tombstones without backups and 4,096 binary
registry rows; new receipt results/reservation requests are at most 8 KiB each.
Slots with recovery history are independently capped by configured `max_slots`;
five revisions per slot and their 30-day expiration remain. Existing accounts
above a cap converge in bounded, generation-fenced maintenance batches. Schema
migration does not erase live saves or historical recovery snapshots.

Exact replay is guaranteed for the latest **3,072 completed operations that are
also younger than 30 days**, not every operation within 30 days. Retained eligible
receipts are checked before rejecting stale context. Before discarding protection,
maintenance advances generation under the same per-user lock. Unrecorded stale
writes return `SAVE_CONFLICT`; clients retain their payload and reconcile
explicitly. In-flight stale commits become garbage without replacing the live
save; covered completed binary receipts survive registry cleanup. Abort/cleanup
remains available. No generationless write fallback exists.

The contract, Edge validation, SDK, offline queues and account-transfer journals
carry generation context. Durable SDK retries require both operation ID and
generation; errors distinguish current server generation from attempted operation
generation. Legacy offline queues are preserved and rejected for explicit
resolution. A fresh concurrency review found and fixed resolution racing with a
new generation at the same revision in another tab. The review also added
explicit binary/delete offline resolution paths, retaining the replaced queue
and Blob payload instead of leaving these operation kinds stranded. A legacy
account-review regression also prevents attaching fresh generation to a stored
target snapshot that has no generation; explicit restart is required. Binary
cache invalidation now includes generation and object identity, preventing reuse
of old bytes when a recreated slot repeats a revision number.

Evidence: retention, generation, ordering, growth and recovery pgTAP tests;
offline/SDK tests; binary integration replay; cleanup concurrency; and a real
0.1.4-to-0.1.5 upgrade using the preserved asset snapshot and normal migration
ledger. The growth run executed 5,000 overwrites plus 1,200 create/delete cycles:
7,400 mutations, 3,304 retained receipts, 1,093,316 receipt-payload bytes and no
more than 1,024 unbacked tombstones. Rate state is deliberately advanced by the
test fixture; separate tests exercise the real clock/rate boundaries.

Logical live-row bounds do not bound MVCC dead tuples or physical relation bytes.
Normal PostgreSQL autovacuum and Storage garbage collection remain necessary.

### Prepare/abort throttle bypass — confirmed

Completed-operation receipts did not count preparation, and abort returned before
the previous limiter. Migration 009 replaces that coupling with three independent
bounded timestamp arrays: 60 completed mutations, 60 new reservations and 60
state-changing aborts per rolling 60 seconds. Existing user locking serializes
allowance checks. Valid exact prepare retries and repeated retained aborts are
free. Cleanup cannot reset counters; failed operations roll back allowance changes.
Pending-upload, payload and registry quotas apply independently.

Evidence: `cloud-saves-lifecycle-rate.test.sql`, existing completed-save rate tests,
concurrent final-allowance reservations, interrupted upload integration and cleanup
concurrency. Failures retain established `RATE_LIMITED`, `SAVE_QUOTA_EXCEEDED`,
`INVALID_SAVE` and `SAVE_CONFLICT` behavior without returning SQL internals.

### Foreign-key indexes — confirmed, with Admin qualification

Catalog checks and query plans confirmed missing leading-column coverage for
best-score user lookup, submission-event board checks and achievement-definition
checks. Leaderboards 004 and Achievements 002 add narrowly scoped indexes. An
existing Admin history index already covers the board key; that optional index
is detected before creation. Admin 002 removes only the exact redundant Supagame
board index when Admin is installed later. Existing indexes and historical SQL
were not rewritten. Functional tests retain account/board cascade behavior and
achievement-definition restrictions.

Evidence: catalog pgTAP tests, rollback-scoped index benchmarks, Admin lifecycle
suite, fresh late-Admin installation and upgrade with Admin already installed.
See the performance artifacts for plans, sizes and insert overhead. This follows
Supabase's guidance to justify indexes with [query plans](https://supabase.com/docs/guides/database/query-optimization),
and to use per-statement helper evaluation for row-independent
[RLS checks](https://supabase.com/docs/guides/database/postgres/row-level-security).

### Deep pagination — confirmed; improved with remaining linear work

The old reader ranked the visible board before cursor filtering. Leaderboards 005
and Admin 002 seek limited candidates, then compute exact global rank offsets
using preceding visible rows and skipped ties. Ranking windows and name joins
process at most the page plus one sentinel. RLS, directions, deterministic tie
ordering, cursor formats and Admin generation invalidation remain intact. There
are no new rank counters/checkpoints or submission locks.

The stable regression budget checks WindowAgg row counts, not wall-clock time.
An independent rank oracle verifies all 9,000 visible rows across many small pages
with extensive ties in both directions, without duplicates or gaps. Existing
ranking and Admin tests cover cursor/visibility semantics. Concurrent writes
retain the pre-existing live-list semantics; pages are not a frozen snapshot.

Exact rank counting remains O(preceding visible rows). Planner-selected RLS
visibility hashing can scan profiles even on page one. This is not constant-time
or bounded-work pagination. See the measured before/after report and raw plans.

## 2. Performance

Completed baseline and optimized runs at 1,000, 10,000, 100,000 and 1,000,000
players per board: 192 matched pagination cases, covering both configurations,
roles, directions, ties and all three page depths. Every optimized RPC timing was
below its matched baseline in this run. The complete [performance report and
artifacts](pre-release-performance/README.md) include compressed raw plans,
buffer/index activity, all comparisons and index relation sizes.

Representative standard/anonymous/DESC RPC times:

| Players | Page | Baseline ms | Optimized ms |
| ---: | --- | ---: | ---: |
| 100,000 | First | 237.878 | 11.493 |
| 100,000 | Middle | 281.809 | 40.199 |
| 100,000 | Deep | 293.318 | 51.859 |
| 1,000,000 | First | 2,167.198 | 0.984 |
| 1,000,000 | Middle | 1,883.694 | 706.647 |
| 1,000,000 | Deep | 1,908.956 | 1,143.263 |

At 100,000 players, the standard user lookup improved from 19.820 to 0.040 ms,
board FK check from 4.120 to 0.010 ms, and achievement FK check from 3.580 to
0.010 ms (rounded). A paired benchmark with three samples of 1,000 inserts shows
median best-score insertion increasing from **46.613 to 59.161 ms (+26.9%)**,
submission events from 22.971 to 23.642 ms (+2.9%), and achievement unlocks from
10.616 to 10.716 ms (+0.9%). The score index costs approximately 12.5 microseconds
per inserted row in that fixture. This is a real tradeoff for eliminating the
player lookup/cascade scan; it is not a production latency guarantee. Pagination
adds no write-side rank counters or checkpoints.

Fresh index sizes for 100,000 synthetic rows per table were 3,178,496 bytes,
720,896 bytes and 720,896 bytes respectively. Admin omits the redundant event
board index. Transactional index builds can block writes during migration on
large existing tables; deployment remains separately authorized.

Runnable harness: `tests/db/performance-benchmark.ts`.
Fixtures contain four boards per player count, 10% hidden players, two directions,
ordinary scores and 100-player tied groups, first/middle/deep pages, both API roles,
and standard/Admin configurations. Fixtures and schema substitutions roll back.
JIT is off, work_mem is 16 MiB, and each statement has a 180-second timeout.

The recorded timings are single-run local observations, not a production SLA.
The first-page planner changes at one million rows; do not extrapolate its
0.984 ms result as a monotonic scaling law.
Repeated rollback fixtures leave physical index pages and influence cache/bloat;
index-size readings include those pages. Work-count/buffer evidence and automated
ranking budgets provide a more stable regression signal than timing ratios.

## 3. Compatibility and verification

Environment: Linux x64, Node **24.22.2 / 26.10.0**, npm **12.2.0**, Deno
**2.9.6**, Supabase CLI **3.0.0 / 3.1.0**. The fixed stack uses PostgreSQL
**17.11.0.011**, Auth **v2.197.0**, Storage **v1.88.0** and Edge Runtime **v1.77.9**.
All four initial 15-command matrix runs and 16 final Node 26 SDK/package reruns
exited zero: **76 successful command runs, zero final failures**. The reruns cover
the final legacy-review regression fix. [Exact outcomes, timings and log hashes](remediation-matrix.json)
are retained separately.

| Node | Supabase CLI | Commands passed | Final units | pgTAP | Concurrent | SDK integration | E2E |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 26.10.0 | 3.0.0 | 23 | 655 | 880 | 27 | 16 | 16 |
| 26.10.0 | 3.1.0 | 23 | 655 | 880 | 27 | 16 | 16 |
| 24.22.2 | 3.0.0 | 15 | 655 | 880 | 27 | 16 | 16 |
| 24.22.2 | 3.1.0 | 15 | 655 | 880 | 27 | 16 | 16 |

Each combination also passed 84 Edge unit tests, 13 Edge integration steps,
33 CLI database tests both before and after SDK integration, two Admin database
tests, two actual-CLI compatibility tests and three isolated package tests.

Each combination selects its Node executable on PATH, then runs
`node scripts/select-test-supabase.ts <3.0.0|3.1.0>` and sets
`SUPABASE_TEST_VERSION` to that CLI version. The exact command sequence is:

```sh
npm run build
npm run typecheck
npm run lint
npm run contracts:check
npm run test
npm run test:cli:compatibility
npm run test:edge
npm run test:packages
npm run db:migrate
npm run test:db
npm run test:cli:db
npm run test:edge:integration
npm run test:sdk:integration
npm run test:cli:db
npm run test:e2e
```

The existing fixed local database is reused without resets. Each E2E run creates
and removes its own synthetic project. The final Node 26 reruns repeat build,
typecheck, lint, contracts, full unit, package consumer, SDK integration and E2E
checks on both CLI versions after the last SDK change. CLI selection is restored
to 3.0.0 afterward.

`npm audit --omit=dev --json` also exited zero: **0 production vulnerabilities**.
`git -c core.whitespace=-blank-at-eof diff --cached --check` passed before
committing. The default staged check flags harmless trailing blank lines in newly
applied SQL files; those bytes are retained to respect migration immutability. All 16 historical migration hashes match the initial
snapshot; see [migration integrity](migration-integrity.json).

No requested Node/CLI environment was unavailable. Hosted deployment is excluded
by authorization; local tests exercise the deployment guardrails and a loopback
management API fixture, not a hosted Supabase project.

Earlier reports describe earlier revisions and are not
counted as newly executed verification. Failures found during this task were
retained in the local execution log and fixed before final reruns:

- Original authorization, growth, throttle and ranking regressions failed before
  their corresponding fixes.
- Initial updated fixtures needed explicit generation context.
- Full unit run under million-player load hit a browser timeout; isolated rerun
  passed all 651 tests.
- Direct PostgREST reads exposed SQLSTATE 25006 and led to migration 012.
- Doctor's policy checks were updated for restrictive identity protection. A
  direct `node --test` invocation lacked npm's CLI PATH; the supported npm script
  passed against the actual catalog and ledger.

## 4. Changes and safeguards

Focused local implementation commits:

| Commit | Scope |
| --- | --- |
| `1785025` | Cloud Saves authorization, generation fencing, bounded replay, lifecycle throttling, SDK/contracts and regressions (39 files) |
| `8c72448` | Exact-rank pagination, FK indexes, plans and before/after benchmarks (17 files) |
| `48205d4` | Module 0.1.5 inventories, preserved 0.1.4 snapshot, doctor checks, upgrade/packaging tests and verification commands (17 files) |

The documentation commit containing this report adds root/package guidance,
protocol/performance guides, the execution ledger, matrix outcomes, migration
integrity evidence and the local Wiki patch. Its hash is provided in the final
response rather than embedded in its own commit.

Principal migrations are `modules/cloud-saves/migrations/008` through `012`,
`modules/leaderboards/migrations/004` and `005`,
`modules/achievements/migrations/002_foreign_key_index.sql` and
`modules/admin/migrations/002_rank_performance.sql`. Runtime changes are in the
shared OpenAPI/generated contracts, Edge `saves.ts`, SDK `saves.ts`,
`offline-saves.ts`, `account-saves.ts`, errors/transport and validators. Tests span
pgTAP, concurrent sessions, real retained JWTs/Auth/Storage, SDK consumers,
optional modules and a fresh 0.1.4 upgrade.

Existing unrelated npm migration work is preserved: 21 pre-existing paths remain
byte-identical (or retain their prior deletion), and task edits were isolated from
pre-existing changes in four overlapping files. Those files are `package.json`,
`RELEASING.md`, SDK generated validators and CLI packaging tests. The npm-tooling
changes remain uncommitted; no unrelated edits entered these focused commits. All 16 pre-existing migration SHA-256 values match the initial
snapshot. Existing journals, deployment target/confirmation safeguards and old
module snapshots remain intact; 0.1.4 was added as an upgrade source and current
module assets advance to 0.1.5. npm package version remains 0.1.0.

Public package `private` flags were already false before this task; this work did
not remove or change them. Root remains private. No packages were published.
The Wiki update is a local draft only. No Wiki push was made.

## Fresh bypass review

The second review was performed inline, respecting the repository prohibition on
subagents. It revisited the five findings independently of the initial static
hypotheses and added reproducing tests for newly discovered problems.

| Attempt | Result / protection |
| --- | --- |
| Retained JWT after hard/soft deletion | RPC, direct table and Storage checks deny access; operator cleanup retains orphan discovery |
| Delete versus prepare in either order | Auth-row lock serialization; no reservation if deletion wins |
| Read-only PostgREST GET | Snapshot identity helper works without forbidden row locks |
| Repeated prepare/abort and concurrent final allowance | Separate bounded counters; exact retries free; new work throttled |
| Cleanup versus stale write | Shared advisory lock and atomic generation change reject stale intent |
| Covered retry after generation/object cleanup | Original JSON/binary receipt returned without mutating current save |
| Forgotten receipt/tombstone, old create, extended offline queue | Stale generation rejected; local payload retained for explicit reconciliation |
| Clock reversal among completed receipts | Durable completion sequence preserves the replay frontier |
| Legacy target review without generation | No fresh-context fallback; journal preserved for explicit restart |
| Same-revision recreation / concurrent local resolution | Generation-aware cache invalidation and local transaction guards |
| Optional Admin installation order | Leading-board index is not duplicated; optimized reader restored after Admin 001 |
| RLS-sensitive ties and deep pages | Exact oracle, bounded ranking windows, caller-scoped counts and generation checks |

The review found no new unresolved security or stale-write bypass after these
fixes. This is an agent-performed local review, not an external security audit.

## 5. Release assessment

**GO — no unresolved release blocker from these five findings, and no missing
requested local verification environment.** The generation protocol/replay change
is breaking and explicitly user-approved. Existing installations must coordinate
migrations, Edge and SDK upgrades; old offline intents require explicit review.

Remaining measured tradeoffs are exact-rank counting on deep pages, added index
storage/write cost, transactional index-build locks and operational cleanup of
legacy oversized history/orphaned objects. Active-account sign-out revocation is
not strengthened beyond JWT semantics. These are documented limits, not claims
of constant-cost ranking, global anti-abuse protection or permanent replay.

The GO applies to the complete tested working tree. Pre-existing npm-tooling work
remains outside the focused remediation commits and must be included in the
reviewed release candidate. No hosted behavior is claimed as newly verified;
no npm publication, private-flag change, release tag, branch/Wiki push or hosted
mutation was performed. See
[Cloud Saves protocol](../guides/cloud-save-protocol.md) and
[leaderboard performance](../guides/leaderboard-performance.md) for client-facing
behavior and operational limits.

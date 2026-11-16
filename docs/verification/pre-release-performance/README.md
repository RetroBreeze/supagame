# Before/after PostgreSQL measurements

Executed locally on 2026-11-16, PostgreSQL 17.11.0.011. The harness loads four
boards at each player scale, 10% hidden profiles, 100-player tied groups,
first/middle/deep pages, ascending/descending order, anon/authenticated roles and
standard/Admin schemas. There are **192 matched pagination cases**, plus index
lookup and 1,000-row insertion measurements. All optimized RPC timings were below
the corresponding baseline in this run. These are single-run observations, not
latency guarantees or statistical confidence intervals.

The original reader/index configurations are restored only inside rollback-only
benchmark transactions. JIT is disabled, work_mem is 16 MiB and statement timeout
is 180 seconds. No hosted target or destructive reset is used. The database was
shared with the existing local fixture; repeated rolled-back synthetic loads can
leave physical index pages and affect caches. No claim of pristine index sizes or
constant write-overhead percentages is made.

## Representative pagination: standard, anonymous, descending

Times are actual `sg_get_entries` RPC EXPLAIN execution times, milliseconds.
The raw artifacts also include nested query plans, buffers and index nodes.

| Players per board | Cursor | Before ms | After ms | Shared hits before / after |
| ---: | --- | ---: | ---: | ---: |
| 1,000 | first | 2.458 | 1.219 | 5,425 / 324 |
| 1,000 | middle | 2.679 | 1.691 | 5,425 / 523 |
| 1,000 | deep | 2.688 | 1.776 | 5,425 / 549 |
| 10,000 | first | 21.577 | 2.768 | 63,117 / 507 |
| 10,000 | middle | 22.654 | 5.191 | 63,117 / 1,067 |
| 10,000 | deep | 23.595 | 6.256 | 63,117 / 1,379 |
| 100,000 | first | 237.878 | 11.493 | 721,037 / 1,379 |
| 100,000 | middle | 281.809 | 40.199 | 721,037 / 5,564 |
| 100,000 | deep | 293.318 | 51.859 | 721,037 / 8,142 |
| 1,000,000 | first | 2167.198 | 0.984 | 3,992,757 / 441 |
| 1,000,000 | middle | 1883.694 | 706.647 | 3,992,757 / 1,997,552 |
| 1,000,000 | deep | 1908.956 | 1143.263 | 3,992,757 / 3,589,590 |

The optimization bounds ranking-window input to page size plus one, but exact
rank offsets still count preceding visible rows. At one million players, deep
pages can still exceed one second. Visibility policies can cause profile scans
or many indexed profile probes. No rank checkpoints, approximate ranks or new
score-submission locks were introduced. The automated budget checks WindowAgg
rows and exact pagination correctness, avoiding a fragile wall-clock threshold.

## Index lookup and write measurements at 100,000 players

Each fixture contains 400,000 best-score rows across four boards. FK cases check
an absent referencing key, exercising the full-scan worst case without deleting
fixtures during measurement. `write` inserts 1,000 best-score rows with triggers
enabled; bulk fixture loading disables score triggers before measuring.

| Configuration | Query | Before ms | After ms |
| --- | --- | ---: | ---: |
| admin | achievementForeignKey | 4.656 | 0.007 |
| admin | boardForeignKey | 0.026 | 0.014 |
| admin | playerLookup | 13.451 | 0.052 |
| admin | write | 59.323 | 57.065 |
| standard | achievementForeignKey | 3.581 | 0.011 |
| standard | boardForeignKey | 4.123 | 0.015 |
| standard | playerLookup | 19.821 | 0.042 |
| standard | write | 48.471 | 50.442 |

Admin's pre-existing history index already made its board FK lookup fast; no
duplicate leading-board index is retained. The additional user and achievement
indexes remain useful with Admin. Index insertion and storage cost are real;
the timings above include ordinary index maintenance and existing triggers.
They do not prove an exact percentage penalty for production score submissions.

Measured additional index relation bytes at the 100,000-player scale (including
reusable pages from prior rolled-back loads):

| Configuration | Index | Bytes |
| --- | --- | ---: |
| standard | `game_best_scores_user_idx` | 11,698,176 |
| standard | `game_submission_events_board_idx` | 712,704 |
| standard | `game_player_achievements_definition_idx` | 811,008 |
| admin | `game_best_scores_user_idx` | 12,722,176 |
| admin | `game_player_achievements_definition_idx` | 1,458,176 |

## Paired index write costs

A second rollback-only benchmark uses the same 100,000-row fixture for both
configurations, rebuilds only the three new indexes, and measures three samples
of 1,000 inserts per table. Each sample rolls back; existing FK checks and
application triggers remain enabled during measurement. Medians in milliseconds:

| Insert target | Without new index | With new index | Difference |
| --- | ---: | ---: | ---: |
| Best scores | 46.613 | 59.161 | +26.9% (+12.548 ms per 1,000 rows) |
| Submission events | 22.971 | 23.642 | +2.9% |
| Achievement unlocks | 10.616 | 10.716 | +0.9% |

The score index has a measurable cost: about 12.5 microseconds per inserted row in
this fixture, with the largest relative change of the three. It is justified by
removing the measured player lookup/account-cascade scan, but applications with
high submission volume should budget for the additional index maintenance. The
pagination algorithm itself adds no write-side rank maintenance. These are local
measurements, not a guaranteed per-request overhead or production throughput.

Freshly rebuilt additional index sizes for 100,000 synthetic rows in each table:
3,178,496 bytes for best-score user lookup, and 720,896 bytes each for the event
board and achievement-definition indexes. The separately captured larger-run
sizes above include reusable pages from previous loads.

```sh
node tests/db/index-write-benchmark.ts
```

`index-writes.json.gz` preserves all 18 write plans and the index-size record.
This harness requires the standard dedicated local fixture, with no concurrent
database tests. Admin already covers the event board key and therefore does not
receive that additional index.

## Reproduction and artifacts

Run against the existing dedicated local fixture, with other database tests
stopped. Each invocation rolls back its synthetic data and schema substitutions:

```sh
node tests/db/performance-benchmark.ts baseline 1000,10000,100000
node tests/db/performance-benchmark.ts optimized 1000,10000,100000
node tests/db/performance-benchmark.ts baseline 1000000
node tests/db/performance-benchmark.ts optimized 1000000
```

The harness writes JSON. Committed `.json.gz` files preserve those exact outputs,
compressed for repository size. Use `gzip -dc <file.json.gz>` to inspect them.
`pagination.csv` contains all 192 paired scenarios; `indexes.csv` contains the
lookup/write comparisons at every scale. JSON plans preserve execution time,
shared/local/temp buffer activity, index scans, filters, rows and loops.

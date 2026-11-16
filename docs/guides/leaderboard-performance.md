# Leaderboard pagination and indexes

Module 0.1.5 seeks candidate rows using the existing ASC/DESC ranking indexes.
It ranks at most `limit + 1` candidates and joins display names for that page.
Exact global competition ranks include a separate count of preceding visible
scores and the skipped portion of a tie. Equal scores still share rank, with
`achieved_at` then player UUID providing deterministic display order. All queries
remain caller-scoped under RLS, including the preceding-row counts.

This is not constant-time pagination. Exact ranks cost O(preceding visible rows)
in the worst case. PostgreSQL can also choose a hashed visibility-policy subplan
that scans visible profiles, even for a first page. The optimization removes
whole-board ranking windows and large name joins; it does not remove all work
that grows with leaderboard size. Normal cursor pagination is not a multi-request
snapshot: concurrent score or visibility changes have the same live-list semantics
as before. Admin generation changes continue invalidating old cursors.

Three targeted indexes support measured queries:

- `game_best_scores_user_idx(user_id)` supports account deletion and live profile
  broadcasts looking up a player's boards.
- `game_submission_events_board_idx(leaderboard_id)` supports board deletion's
  referencing-row checks. It is omitted when Admin's leading-board history index
  already covers the query; late Admin installation removes only this redundant
  Supagame index.
- `game_player_achievements_definition_idx(achievement_id)` supports achievement
  definition foreign-key checks and deletion.

These indexes consume storage and add ordinary index maintenance to writes.
The additive migrations use transactional index builds, which can block writes
while building on existing large tables; schedule their separately approved
deployment accordingly. There
are no rank checkpoints, global counters or new submission locks. See the retained
[performance measurements](../verification/pre-release-performance/) for execution
plans, buffers, insert measurements and index sizes. The automated ranking budget
asserts a maximum of `limit + 1` WindowAgg rows and verifies all pages against an
independent competition-rank oracle; it does not impose fragile wall-clock limits.

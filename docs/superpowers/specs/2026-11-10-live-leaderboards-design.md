# Live Leaderboards design

The user's end-to-end feature request supersedes the v0.1 exclusion of live
leaderboard pushes and the one-numbered-task restriction for this implementation.
The existing approved HTTP, SQL ranking, RLS and deployment contracts remain.

Chosen design: optional `live-leaderboards` inventory entry, depending on
leaderboards; private receive-only database Broadcast with a board ID, followed
by existing HTTP reads. Row broadcasting would expose unnecessary data and
couple clients to storage; polling would introduce continuous traffic. Neither
is needed. No new ranking engine, backend service, or hosted dashboard is added.

Implement and verify in one pass: provisioning/dependency tests; additive trigger
migration and SQL/RLS tests; SDK lifecycle and rank-transition tests; real local
WebSocket integration; tarball installation in Vaccoin; title-screen Canvas
integration and mocked desktop/mobile browser checks. Commit repositories
separately after checks. Preserve pre-existing untracked files. Hosted writes,
package publication, remote push and merges remain outside authorization.

Runtime, lifecycle semantics, operational decisions and limitations are recorded
in ../../live-leaderboards.md. The author selected these technical decisions
under the user's explicit autonomous implementation authorization.

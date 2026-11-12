# Supabase Game Services v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an MIT-licensed, installable Supabase leaderboard module with anonymous player identities, secure score submission, a public HTTP API, and a TypeScript client.

**Architecture:** An npm CLI stages versioned SQL migrations and a Supabase Edge Function into the developer's existing project, then deploys only with explicit destination confirmation. The Edge Function exposes an engine-independent API, backed by PostgreSQL and Supabase Auth; a thin TypeScript SDK uses the same HTTP contract. All game data remains in the developer's Supabase project.

**Tech Stack:** TypeScript, Node.js 24 LTS, pnpm, Vitest, Deno/Edge Functions, `@supabase/server`, `@supabase/supabase-js`, PostgreSQL, pgTAP, Supabase CLI v3, OpenAPI 3.1. Use the stable compatible versions at implementation start and lock them in the repository.

**Spec:** [Approved design](https://chatgpt.com/space/page_16bd151887748191bd25f6b969abdfd2) — “Supabase Game Services v0.1 Technical Design Draft” (approved 2026-11-08). When the repository is created, check in a copy at `docs/superpowers/specs/2026-11-08-supabase-game-services-design.md` and retain this reference.

## Global Constraints

- There is **no existing software repository** in the supplied workspace. Start a new Git repository only when implementation is approved; never touch Toy Tanks or other projects directly.
- Provisional npm namespace and CLI executable: `@retrobreeze/supagame-cli` / `supagame`; confirm availability before publication, rename consistently if unavailable.
- One Supabase project corresponds to one game; no central hosted service or multi-game tenancy in v0.1.
- Default authentication is anonymous Supabase Auth, but existing authenticated sessions must be retained.
- Database scores are `BIGINT`; the JSON API and JavaScript SDK accept only safe integer values, documented as `Number.isSafeInteger(score)`, to avoid precision loss.
- Boards support `asc` and `desc`, one best score per player, equal scores sharing competition rank, deterministic tie display order.
- Public endpoints are read-only; authenticated users can submit only scores for their own identity. No admin/secret key in game clients.
- Developer provisioning is repeatable and additive. No destructive reset, automated data deletion, or unconfirmed hosted mutation.
- Supabase CLI v3 remote database commands **require `--remote=<project-ref>`**; remote writes need explicit user consent. Do not rely on bare `db push` targeting production.
- Test each change before committing; use narrow commits and keep generated migrations in version control.

## Review Focus

1. **Wrong project selected:** CLI deploy must show the exact project ref and refuse a changed/missing destination without explicit confirmation (Task 8).
2. **Simultaneous better/worse submissions:** transactional update must retain the actual best without duplicate per-user rows (Task 4).
3. **Lost or existing auth session:** TypeScript SDK must reuse existing sessions and surface anonymous recovery limitations without silently replacing credentials (Task 10).
4. **Tied scores across pages:** competition rank and continuation cursors must never duplicate or skip entries (Task 5).
5. **Anonymous-abuse / unauthorized writes:** direct table writes and forged player IDs must fail; repeated anonymous submissions must meet rate limits (Tasks 3, 4, 6).

---

## Proposed repository map

| Path | Responsibility |
| --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | Monorepo tooling and scripts |
| `packages/contracts/openapi.yaml` | Authoritative public HTTP contract |
| `packages/contracts/src/types.ts` | Request/response and error DTOs used by JS client and API tests |
| `packages/cli/src/cli.ts` | CLI entrypoint and command registration |
| `packages/cli/src/commands/*.ts` | `init`, `add`, `leaderboard-create`, `deploy`, `doctor`, `upgrade` |
| `packages/cli/src/lib/*.ts` | Manifest IO, safe file staging, project resolution, Supabase CLI adapter |
| `modules/core/migrations/*.sql` | Player identity/profile schema, grants and policies |
| `modules/leaderboards/migrations/*.sql` | Board/score schema, trusted SQL APIs, indexes |
| `modules/leaderboards/functions/supagame/*.ts` | Versioned HTTP routing, auth, validation and error mapping |
| `packages/sdk-ts/src/*.ts` | Runtime TypeScript API and anonymous-session adapter |
| `tests/db/*.sql`, `tests/api/*.test.ts`, `tests/cli/*.test.ts` | pgTAP, HTTP, and CLI behavior tests |
| `tests/e2e/*.test.ts` | Installation and lifecycle tests against a local Supabase stack |
| `examples/capacitor-demo/`, `docs/` | Integration example, quickstart, API and security docs |

## Task 1: Bootstrap the CLI entrypoint and lock the API contract

**Files:** Create root package/workspace/tooling files, `packages/cli/src/cli.ts`, `tests/cli/help.test.ts`, `packages/contracts/openapi.yaml`, `packages/contracts/src/types.ts`, `tests/api/contract.test.ts`, `README.md`, `LICENSE`, and the checked-in design spec.

**Interfaces:** Define `LeaderboardSummary`, `LeaderboardEntry`, `LeaderboardPage`, `MyScore`, `SubmitScoreRequest { score: number; submissionKey: string }`, `SubmitScoreResult { outcome: 'best' | 'not_best'; score: number; bestScore: number }`, `PlayerProfile`, `ApiError { code: string; message: string }`. HTTP base path `/functions/v1/supagame/v1`, with `GET /leaderboards`, `GET /leaderboards/{id}/entries`, `GET /leaderboards/{id}/me`, `POST /leaderboards/{id}/scores`, `GET /players/me`, `PATCH /players/me`.

- [ ] **Step 1 — failing tests:** In `tests/cli/help.test.ts`, assert `supagame --help` lists `init`, `add`, `leaderboard`, `deploy`, `doctor`, `upgrade`. In `tests/api/contract.test.ts`, assert OpenAPI contains all six routes, method-specific authentication, the response DTO names, and a 1–100 page limit.
- [ ] **Step 2 — red:** Run `pnpm vitest run tests/cli/help.test.ts tests/api/contract.test.ts`; expect missing entrypoint/schema failures.
- [ ] **Step 3 — implement:** Create the workspace, minimal CLI command registration and `--help`, OpenAPI contract, TS DTOs and test script; use one consistent error envelope and JSON-safe integer rules. CLI subcommands may return a clear `not yet implemented` error until their owning tasks.
- [ ] **Step 4 — green:** Re-run both tests, `pnpm -r typecheck`, and `pnpm -r lint`; expect success.
- [ ] **Step 5 — commit:** `git add . && git commit -m "chore: bootstrap game services contracts"`.

## Task 2: Create database schema, grants and ranking indexes

**Files:** Create `modules/core/migrations/001_players.sql`, `modules/leaderboards/migrations/001_leaderboards.sql`, `tests/db/schema.test.sql`.

**Interfaces:** `public.game_players(user_id uuid primary key references auth.users, display_name text, hidden boolean, created_at timestamptz)`; `public.game_leaderboards(id text primary key, kind text, sort_direction text, min_value bigint, max_value bigint, enabled boolean)`; `public.game_best_scores(leaderboard_id text, user_id uuid, score bigint, achieved_at timestamptz, submission_key uuid, primary key(leaderboard_id,user_id))`; `sg_private.game_submission_events(user_id, leaderboard_id, submission_key, submitted_score, outcome, created_at)` with a unique `(user_id,leaderboard_id,submission_key)` key. Create `sg_private` schema and indexes for both ranking directions. Expose only safe functions later.

- [ ] **Step 1 — failing tests:** pgTAP asserts required fields/constraints, uniqueness, foreign keys, indexes, RLS enabled on public tables, and zero direct client INSERT/UPDATE/DELETE permissions.
- [ ] **Step 2 — red:** Run `supabase test db` after staging migrations in a local test fixture; expect failure for missing tables.
- [ ] **Step 3 — implement:** Add migrations; grant only public read access to allowed leaderboard/player rows, restrict score and submission-event writes, and keep private tables outside exposed schemas.
- [ ] **Step 4 — green:** Re-run `supabase test db`; expect all pgTAP assertions to pass.
- [ ] **Step 5 — commit:** Commit schema migration and tests.

## Task 3: Player identity, profile operations and RLS

**Files:** Create `modules/core/migrations/002_player_functions.sql`, `tests/db/players.test.sql`.

**Interfaces:** `public.sg_get_my_profile() RETURNS jsonb`, `public.sg_update_my_profile(p_display_name text) RETURNS jsonb`; each reads the caller with `auth.uid()` and never accepts an arbitrary player UUID. On first authenticated call, create the profile if absent; display names allow 3–24 printable characters and trim surrounding whitespace.

- [ ] **Step 1 — failing tests:** Assert an anonymous user can create/read/update their profile, another user cannot change it, a guest with no JWT cannot update, hidden profiles are absent from public listings, and an existing permanent Supabase user is accepted.
- [ ] **Step 2 — red:** Run `supabase test db`; expect missing function failures.
- [ ] **Step 3 — implement:** Add narrow SQL functions, `auth.uid()` checks, safe search paths and exact EXECUTE grants; ensure first-call profile creation is race-safe.
- [ ] **Step 4 — green:** Run database tests and verify denied direct writes to the base player table.
- [ ] **Step 5 — commit:** Commit profile module and tests.

## Task 4: Atomic score submission, idempotency and throttling

**Files:** Create `modules/leaderboards/migrations/002_submit_score.sql`, `tests/db/submission.test.sql`.

**Interfaces:** `public.sg_submit_score(p_board_id text, p_score bigint, p_submission_key uuid) RETURNS jsonb` with outcomes `best` and `not_best`; use authenticated `auth.uid()` rather than supplied user IDs. Maximum 10 submissions per authenticated user per board per rolling 60 seconds, backed by events; reject disabled boards and scores outside configured bounds. Reusing the same idempotency key and score returns its prior outcome; reusing it for a different score fails with `DUPLICATE_KEY_CONFLICT`.

- [ ] **Step 1 — failing tests:** Assert first/better/worse/equal scores, ascending/descending semantics, score boundaries, replay idempotency, conflicting replay, disabled board, 11th rapid submission rejection, anonymous-user token validation, and concurrent better/worse writes.
- [ ] **Step 2 — red:** Run `supabase test db`; expect missing function failures.
- [ ] **Step 3 — implement:** Validate within SQL and use transactional conditional `INSERT ... ON CONFLICT DO UPDATE` so no racing submission makes the best score worse. Serialize per-user/per-board event checks where required; document that per-identity limits cannot stop multiple newly created anonymous accounts.
- [ ] **Step 4 — green:** Run pgTAP and the concurrent submission test harness; verify one best-score row per player/board.
- [ ] **Step 5 — commit:** Commit trusted submission implementation and tests.

## Task 5: Ranking queries, ties and pagination

**Files:** Create `modules/leaderboards/migrations/003_rank_reads.sql`, `tests/db/rankings.test.sql`.

**Interfaces:** `public.sg_list_leaderboards() RETURNS jsonb`, `public.sg_get_entries(p_board_id text, p_limit integer, p_cursor jsonb DEFAULT NULL) RETURNS jsonb`, and `public.sg_get_my_score(p_board_id text) RETURNS jsonb`. Entries contain `playerId`, `displayName`, `score`, `rank`, `achievedAt`; response contains `nextCursor` or null. A cursor encodes the last `(score, achieved_at, user_id)` tuple and board ID; reject cursors from another board.

- [ ] **Step 1 — failing tests:** Verify both sort directions; tied values share rank; order is score, achievement timestamp, user ID; pagination from 1 to 100 excludes duplication/skips (especially a page ending mid-tie); missing/disabled/hidden data does not leak; `me` returns null with no score.
- [ ] **Step 2 — red:** Run `supabase test db`; expect absent query functions.
- [ ] **Step 3 — implement:** Use indexed, bounded SQL ranking reads with stable cursor validation; compute the published competition rank consistently for top pages and personal rank.
- [ ] **Step 4 — green:** Re-run pgTAP and an explain-plan sanity check for both sort orders.
- [ ] **Step 5 — commit:** Commit ranking functions and tests.

## Task 6: Secure, versioned Edge HTTP API

**Files:** Create `modules/leaderboards/functions/supagame/index.ts`, `routes.ts`, `auth.ts`, `responses.ts`, and `tests/api/http.test.ts`.

**Interfaces:** Implement all Task 1 routes and DTOs. GET list/entries accepts a publishable key without a player session; GET `me`, POST scores, and profile endpoints require a valid Supabase user JWT. SQL calls use the caller-scoped Supabase client; never use admin bypass for player-owned requests. Errors map to stable HTTP statuses and `ApiError` codes. Browser CORS permits configured origins and OPTIONS; max page size 100 and body size 4 KiB.

- [ ] **Step 1 — failing tests:** Test all six routes, CORS preflight, missing/invalid publishable key, missing/expired user JWT, forged `userId`, unsafe JSON integers, too-large payload, malformed cursor, board not found, rate limit, and no admin credentials on response surfaces.
- [ ] **Step 2 — red:** Run `deno test -A tests/api/http.test.ts`; expect missing route handlers.
- [ ] **Step 3 — implement:** Route under `/v1`, with `verify_jwt=false` only if needed for mixed public/auth routes and **explicit route-level verification** via the supported `@supabase/server` auth modes. Keep user-required routes fail-closed. Match OpenAPI responses exactly.
- [ ] **Step 4 — green:** Run Deno tests, contract validation, and local Edge integration tests; ensure authenticated and public routes are separated correctly.
- [ ] **Step 5 — commit:** Commit HTTP API and tests.

## Task 7: CLI setup and module staging

**Files:** Create `packages/cli/src/cli.ts`, `packages/cli/src/commands/init.ts`, `add.ts`, `packages/cli/src/lib/manifest.ts`, `file-stage.ts`, `tests/cli/init.test.ts`, `tests/cli/add.test.ts`.

**Interfaces:** `supagame init` creates `supagame.config.json`; `supagame add leaderboards` copies known versions of migration/function templates into an existing Supabase project without overwriting user files. The manifest includes `formatVersion`, `projectRef`, `modules`, and `leaderboards`. Add separate `--dry-run` support for local preview.

- [ ] **Step 1 — failing tests:** In temporary fixture directories, test empty project, existing Supabase project, repeat invocation (no changes), conflicting filenames (actionable error), unknown module (error), and preservation of unrelated files.
- [ ] **Step 2 — red:** Run `pnpm --filter @retrobreeze/supagame-cli test`; expect missing CLI commands.
- [ ] **Step 3 — implement:** Add CLI parser, schema-validated manifest, safe staging, and template version inventory. Never modify or read another user's project outside the explicit working directory.
- [ ] **Step 4 — green:** Run CLI unit tests and a filesystem snapshot comparison for idempotent repeated installs.
- [ ] **Step 5 — commit:** Commit CLI bootstrap and module staging.

## Task 8: CLI leaderboard creation and explicitly confirmed deployment

**Files:** Create `packages/cli/src/commands/leaderboard-create.ts`, `deploy.ts`, `packages/cli/src/lib/supabase-cli.ts`, `packages/cli/src/lib/migration-generator.ts`, `tests/cli/deploy.test.ts`.

**Interfaces:** `supagame leaderboard create <id> --type time|points --order asc|desc --keep-best [--min N --max N]` validates and records a board in the manifest, producing a deterministic additive migration. `supagame deploy --project-ref <ref>` previews destination and pending migrations. Only after explicit interactive consent does it invoke Supabase CLI v3 with `db push --remote=<ref> --yes` and `functions deploy --remote=<ref> --yes`. Noninteractive deploy requires a separately named opt-in flag; default fails closed.

- [ ] **Step 1 — failing tests:** Mock Supabase CLI process calls. Assert wrong/missing/mismatched project refs fail, declined prompt makes zero remote calls, CI without opt-in fails, repeated board creation is no-op, conflicting definitions error, migration SQL escapes inputs, and confirmed deploy includes explicit remote target flags.
- [ ] **Step 2 — red:** Run CLI tests; expect missing deploy/create commands.
- [ ] **Step 3 — implement:** Generate versioned migrations, verify target identity, preview *all* pending remote migrations (including unrelated project migrations), require consent before passing `--yes`, then deploy. Do not call `db reset`, `functions delete`, or `--prune`.
- [ ] **Step 4 — green:** Re-run CLI tests and a dry-run against a fixture with unrelated pending migrations.
- [ ] **Step 5 — commit:** Commit provisioning and safe deployment logic.

## Task 9: Diagnostics and forward-only upgrades

**Files:** Create `packages/cli/src/commands/doctor.ts`, `upgrade.ts`, `packages/cli/src/lib/versions.ts`, `tests/cli/maintenance.test.ts`.

**Interfaces:** `supagame doctor` reports linked project, anonymous-auth setting, module/schema versions, Edge Function health, read/write grants and configuration drift; `supagame upgrade` stages newer additive migration/template versions locally and never silently deploys or removes data.

- [ ] **Step 1 — failing tests:** Simulate missing anonymous sign-in setting, missing function, outdated schema, manifest drift, repeated upgrade and unreachable remote; verify actionable output and no destructive calls.
- [ ] **Step 2 — red:** Run CLI tests; expect missing diagnostic commands.
- [ ] **Step 3 — implement:** Add version inventory, read-only checks, and staged upgrades with clear local/remote provenance.
- [ ] **Step 4 — green:** Run CLI tests and verify no `--yes` remote mutation occurs in maintenance commands.
- [ ] **Step 5 — commit:** Commit diagnostics and upgrade staging.

## Task 10: TypeScript SDK and anonymous player lifecycle

**Files:** Create `packages/sdk-ts/src/index.ts`, `client.ts`, `players.ts`, `leaderboards.ts`, `errors.ts`, `tests/sdk/session.test.ts`, `tests/sdk/leaderboards.test.ts`.

**Interfaces:** `createGameServices({supabase, baseUrl?}): GameServices`; `players.ensureAnonymousSession(): Promise<{userId:string}>`; `players.getMe(): Promise<PlayerProfile>`; `players.updateMe({displayName}): Promise<PlayerProfile>`; `leaderboards.getTop(id, {limit?,cursor?}): Promise<LeaderboardPage>`; `leaderboards.getMine(id): Promise<MyScore|null>`; `leaderboards.submit(id, score, submissionKey?): Promise<SubmitScoreResult>`. A shared Supabase client owns session persistence/token refresh; SDK never embeds an admin key.

- [ ] **Step 1 — failing tests:** Mock auth and fetch. Assert anonymous sign-in only when no session exists, existing permanent/anonymous session reused, failed/revoked session yields clear error, SDK sends current user JWT and publishable key, retries preserve submission key, and network/API errors map to typed errors.
- [ ] **Step 2 — red:** Run `pnpm --filter @retrobreeze/supagame-sdk test`; expect missing exports.
- [ ] **Step 3 — implement:** Add typed wrappers aligned with OpenAPI, token refresh through the supplied Supabase client, JSON safe-integer checks, and platform-independent session handling.
- [ ] **Step 4 — green:** Run SDK tests, typecheck and package build; verify no server-only dependencies in client output.
- [ ] **Step 5 — commit:** Commit TypeScript client and tests.

## Task 11: End-to-end consumer, security regression and public docs

**Files:** Create `tests/e2e/install-and-play.test.ts`, `examples/capacitor-demo/*`, `docs/quickstart.md`, `docs/api.md`, `docs/security.md`, `docs/troubleshooting.md`, `docs/upgrades.md`, release configuration and examples in root README.

**Interfaces:** A developer can install two boards (`level-1`, time/asc; `arcade`, points/desc), obtain an anonymous user, submit and read scores using both the TS SDK and raw HTTP, and later upgrade that anonymous identity using configured Supabase Auth identity linking.

- [ ] **Step 1 — failing E2E:** Start from a fresh local Supabase stack and empty fixture project; assert CLI setup, a repeat setup, two board definitions, anonymous user, accepted/rejected score cases, top/personal ranks and raw HTTP access. Assert forbidden direct score-table write and no server key in the built example.
- [ ] **Step 2 — red:** Run `pnpm test:e2e`; expect missing fixture/example or failing workflow.
- [ ] **Step 3 — implement:** Complete the minimal Capacitor-compatible demo, packaging, API/quickstart/security/troubleshooting/upgrade docs, account-linking example, and CI jobs for database/API/CLI/SDK/E2E suites. Test the CLI's published package contents in a clean fixture rather than only source imports.
- [ ] **Step 4 — green:** Run `pnpm -r test`, `pnpm -r typecheck`, `pnpm test:e2e`, and `pnpm -r build`; review a clean install from a packed CLI tarball.
- [ ] **Step 5 — commit:** Commit docs, example and release readiness work. Do not publish npm or mutate a production Supabase project without explicit separate authorization.

## Execution notes

- The new repository has not yet been initialized; do not run implementation commands until the user approves execution. If they provide an existing repository, map these paths onto its conventions before making changes.
- Use local Supabase fixtures and synthetic accounts for all automated tests. Any hosted deployment must show destination and obtain approval.
- The first task establishes the developer-facing CLI entrypoint. Its provisioning subcommands become functional in Tasks 7–9 after the database and API foundations are verified.
- Keep each task's tests and commit together. Run a final security review of SQL grants, security-definer search paths, JWT handling and deploy target selection before a public release.
- Follow current [Supabase CLI v3 remote-target guidance](https://supabase.com/docs/guides/local-development/cli/migrating-to-v3) and [Edge Function auth guidance](https://supabase.com/docs/guides/functions/auth); verify versioned commands at implementation time.

# Supabase Game Services

An MIT-licensed toolkit for installing modular gaming services into your own
Supabase project. The planned v0.1 provides anonymous player identities and
leaderboards through a versioned HTTP API, a provisioning CLI, and a thin
TypeScript SDK. There is no central service operated by this project.

**Status: Tasks 1–7 implemented.** CLI help, the HTTP contract, shared DTOs,
workspace tooling, database schema, profile operations, atomic score submission,
ranked reads, the versioned Edge HTTP API, and local CLI setup/staging are
implemented. Leaderboard creation, deployment, maintenance commands and the
runtime SDK remain future tasks.
Nothing is deployed to a hosted project or published.
`@supagame/*` and the `supagame` executable are provisional names; all packages
are private until publication is separately approved.

## Local development

Use Node.js **24 LTS** (`.node-version` pins 24.22.2) and pnpm **12.18.0**.
Install that pnpm version using your preferred package-manager setup, for example
`npm install --global pnpm@12.18.0`, then run from this repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter @supagame/cli dev --help
pnpm test
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm build
node packages/cli/dist/cli.js --help
```

`pnpm typecheck` checks tests and configuration as well as each package.
`pnpm -r typecheck`, `pnpm -r lint` and `pnpm -r build` check the workspace
packages individually. `pnpm --filter @supagame/cli test` and
`pnpm --filter @supagame/contracts test` select their respective suites.
The TypeScript tests need no Supabase credentials or Docker stack. Database
tests use the local fixture below. Deno HTTP tests and local Edge integration
are described below; the broader end-to-end suite remains a later task.

TypeScript 5.9.3 is pinned because it is compatible with both the OpenAPI type
generator and TypeScript ESLint. Dependencies are exact versions and the pnpm
lockfile is committed. Packages use ESM, strict typing, and NodeNext resolution;
contracts contain no runtime dependencies. Generated output is ignored.

## Local database tests

Docker must be running. Supabase CLI **3.0.0** is an exact development dependency;
use the repository's scripts so a different global CLI version is not selected.
The fixture in `tests/fixtures/local/supabase/` has project ID
`supagame-schema-tests`, PostgreSQL 17, and database port **55432**. `pnpm db:start` starts
only the local database, including Supabase's Auth schema and roles. No hosted
credentials or project link are needed. Initial startup downloads Docker images.

Create this Docker network once to bind the database port to loopback only
(the [Supabase local-development guidance](https://supabase.com/docs/guides/local-development)
describes this setting):

```sh
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 supagame-schema-tests-local
```

Then start and test the fixture:

```sh
pnpm db:start
pnpm db:migrate
pnpm test:db
pnpm db:migrate # repeated installation: no pending migrations
pnpm db:stop    # stops this fixture and preserves its local database volume
```

`pnpm test:db` runs `supabase test db` against the fixture with its dedicated
network and `tests/db/schema.test.sql`, `tests/db/players.test.sql`,
`tests/db/submission.test.sql`, `tests/db/rankings.test.sql`, and
`tests/db/rankings-plans.test.sql`.
These pgTAP suites create synthetic Auth users and roll back their fixtures and
temporary grants. They check schema constraints, RLS, grants, profile operations,
name validation and actual allowed/denied queries as `anon` and as `authenticated`
with both anonymous and permanent user claims. This tests database authorization;
JWT verification and HTTP behavior have separate Edge tests below.

After pgTAP, `pnpm test:db` also runs `pnpm test:db:concurrency`. This uses Docker
to open real `psql` sessions in the fixed local fixture container. Profile cases
hold the first insert uncommitted and verify the second request is waiting on a
database lock before releasing it. All four get/update combinations must return
one consistent profile; score concurrency cases are described below. Synthetic users are committed
so both sessions can see them, then deleted in `finally` cleanup. Server timeouts
bound failed tests. The harness does not accept a hosted database connection.

`pnpm db:stage` copies module migrations into the fixture's ignored migrations
directory with stable, globally unique versions. Core tables come before
leaderboards, followed by profile functions, score submission and ranking reads.
Existing identical copies are left alone; differing copies fail instead of
overwriting them. The migration ledger makes repeated installation
a no-op. Raw SQL files are intentionally **apply-once**: an existing object with
the same name causes failure rather than silently accepting an incompatible
schema. Future changes must be new, additive migrations. The staging helper is
test infrastructure; it does not implement the future provisioning CLI.

The database foundation provides:

- `game_players`, linked to `auth.users`, with nullable display names and a hidden flag.
- `game_leaderboards`, with time/points kinds, asc/desc ordering and optional bounds.
- `game_best_scores`, with one row per board/player and two ranking indexes that
  preserve ascending achievement-time/player-ID tie order for both score directions.
- `sg_private.game_submission_events`, keyed by player/board/submission UUID,
  with a rate-window index and the original result's best score for exact replay.

RLS permits reads of enabled boards, visible profiles and their scores. Explicit
column grants keep moderation flags and submission keys out of public reads.
Neither API role can insert, update, delete, truncate, or create foreign keys or
triggers against these tables. The private schema has no API-role access, is excluded
from the fixture's exposed schemas, and its event table also has default-deny RLS.
Migrations revoke Supabase's automatic client grants on these tables without
changing privileges on unrelated application objects.

Scores and bounds use `BIGINT` constrained to JSON-safe integers. Trusted deletion
of an Auth user or board cascades to dependent toolkit records, preventing
orphans. There are no client delete permissions.

## Player profile SQL operations

The database now exposes `public.sg_get_my_profile()` and
`public.sg_update_my_profile(p_display_name text)`, both returning the
`PlayerProfile` JSON shape: `playerId`, nullable `displayName`, and `createdAt`.
They support anonymous and permanent Supabase Auth users equally. The first
valid read or update creates the profile; repeated reads preserve its contents.
Neither operation accepts a target user ID.

The two `SECURITY DEFINER` functions pin an empty `search_path`, use qualified
database references, and derive identity from `auth.uid()`. Only `authenticated`
and the trusted function owner may execute them; `PUBLIC`, `anon` and
`service_role` receive no execute grant. Missing/malformed subjects and
nonexistent/deleted Auth users fail with SQLSTATE `28000`, message `UNAUTHORIZED`.
The gateway must still verify JWT signatures and expiration before setting claims.

Updates trim surrounding ASCII/Unicode whitespace, then require 3–24 Unicode
characters (code points, not UTF-8 bytes). Embedded C0/C1 controls are rejected,
matching the existing contract. Invalid names fail with SQLSTATE `22023`, message
`INVALID_DISPLAY_NAME`, without creating or changing a profile. Validation and
renaming do not constitute content moderation.

Profile creation uses the existing primary key and conflict handling. The getter
reads in a separate statement after a conflicting insert completes, using the
normal PostgreSQL `READ COMMITTED` isolation level. The updater performs an atomic
insert/update of `display_name` only. Higher transaction isolation levels may
require the caller to retry serialization failures, as with other PostgreSQL writes.
No table grants or RLS policies were broadened. Hidden owners may read and rename
their own profile, but cannot unhide it; it remains absent from public listings.
Moderation flags are never included in either JSON response.

## Score submission SQL operation

`public.sg_submit_score(p_board_id text, p_score bigint, p_submission_key uuid)`
returns exactly `{ outcome: 'best' | 'not_best', score, bestScore }`. It derives
the player from `auth.uid()` and creates their profile if necessary. New submissions
require an enabled board and a JSON-safe integer within its optional inclusive
bounds. Smaller scores improve `asc` boards; larger scores improve `desc` boards.
Equal or worse scores preserve the original best's timestamp and submission key.

A transaction-scoped advisory lock serializes each player/board pair's replay
lookup, quota check, conditional upsert and event insertion. Different pairs can
proceed independently. Board configuration is held under a shared row lock while
processing new submissions. Server processing time, rather than transaction start
time, determines the rolling window and achievement timestamp.

The limit is **10 accepted distinct submissions per player/board per rolling
60 seconds**, including `not_best` results. Rejected requests consume no quota.
An identical key/score replays its original complete response without spending
quota, even after later improvements, board disablement or changed bounds.
A valid score differing from a stored key's score raises `DUPLICATE_KEY_CONFLICT`.
Keys are scoped to a player and board. Events currently remain until their player
or board is deleted; no automatic retention/purge policy is implemented. Removing
an event also removes that key's replay guarantee, so the rate window is not an
event-retention policy.

The new migration adds required private `best_score` metadata; earlier migrations
are unchanged. Before Task 4 there was no supported submission writer. If events
were manually seeded beforehand, migration fails rather than inventing historical
results or deleting data. Resolve such data explicitly before upgrading.

Only `authenticated` and the trusted owner may execute the function. Its empty
`search_path`, qualified references, identity checks and explicit JSON construction
preserve existing RLS and column grants. PostgreSQL's default `READ COMMITTED`
is required (`READ UNCOMMITTED` has the same PostgreSQL semantics).
`REPEATABLE READ` and `SERIALIZABLE` fail closed with SQLSTATE `0A000`,
`READ_COMMITTED_REQUIRED`, preventing stale snapshots from bypassing event checks.
See [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html).

SQL errors use `UNAUTHORIZED` (`28000`), `INVALID_REQUEST` / `INVALID_SCORE`
(`22023`), `LEADERBOARD_NOT_FOUND` (`P0002`, including disabled boards),
`DUPLICATE_KEY_CONFLICT` (`23505`), and `RATE_LIMITED` (`P0001`). Authentication
and basic argument validation precede replay. The Edge adapter maps these errors
and verifies JWT signatures before calling SQL. Per-identity throttling does not stop
anonymous account farming or prove that a submitted score represents real gameplay.

`pnpm test:db:concurrency` uses separate local PostgreSQL sessions to test profile
creation, competing better/worse/equal submissions, duplicate/conflicting keys,
the last quota slot, retries at quota, processing timestamps, isolation rejection,
and independent player/board pairs. Contention tests inspect actual lock waits
before releasing the first transaction; synthetic committed data is cleaned up.

## Ranking and pagination SQL operations

- `public.sg_list_leaderboards()` returns enabled `LeaderboardSummary` objects,
  ordered by ID, or `[]`. It lists all developer-managed board definitions.
- `public.sg_get_entries(p_board_id text, p_limit integer DEFAULT 50,
  p_cursor jsonb DEFAULT NULL)` returns `{ entries, nextCursor }`. Limits must be
  1–100; an explicitly null limit is invalid. Empty pages return `[]` and a null cursor.
- `public.sg_get_my_score(p_board_id text)` uses `auth.uid()` and returns the same
  entry DTO, or JSON `null` for no visible score (including a hidden owner).
  This read never creates a profile or accepts a target player ID.

Entries contain only `playerId`, nullable `displayName`, `score`, `rank`, and
`achievedAt`. Competition rank uses score alone: ties share a rank and subsequent
places are skipped (`1, 1, 3`). Display order uses score in the board's direction,
then ascending achievement timestamp and UUID. Hidden players are excluded before
calculating ranks. Personal standings count strictly better visible scores and
therefore agree with entry pages.

The cursor describes the last returned tuple as
`{ boardId, score, achievedAt, playerId }`. `nextCursor` is its JSON serialization
as a **string**, matching the existing HTTP contract. Clients should treat that
string as opaque. The HTTP adapter parses it into the RPC's JSONB input;
SQL callers can pass `(previous_page ->> 'nextCursor')::jsonb`. HTTP callers
URL-encode the opaque string as the `cursor` query parameter. Scores must be safe
integers, timestamps must
include a timezone and preserve up to six fractional digits, and UUIDs must use
the canonical hyphenated form. Invalid types, missing/extra fields, another board's
cursor, or decoded cursors exceeding 4 KiB raise `22023 / INVALID_CURSOR`.
Cursors are positions in public data, not signed authorization tokens; they need
not refer to a row that still exists.

Ranking precedes cursor filtering, so pages beginning midway through a tie keep
their global rank. A `limit + 1` lookahead determines whether a continuation exists.
The functions are `STABLE`, giving each call a consistent query snapshot
([PostgreSQL volatility documentation](https://www.postgresql.org/docs/17/xfunc-volatility.html)).
Separate pages are not a shared snapshot: concurrent score, visibility or board
changes can change ranks and page membership. Ordering is deterministic for unchanged data.

All three functions use `SECURITY INVOKER`, an empty `search_path`, qualified
references and explicit output fields. Existing table grants and RLS remain in
force, including additional caller policies. `anon` and `authenticated` can list
boards and entries; only `authenticated` can request a personal standing. Neither
`PUBLIC` nor `service_role` receives execution grants. Missing/disabled boards
raise `P0002 / LEADERBOARD_NOT_FOUND`; invalid limits raise `22023 / INVALID_REQUEST`;
missing/malformed personal subjects raise `28000 / UNAUTHORIZED`.

The plan suite uses 10,000 players on each sort direction, with real API-role RLS
and `EXPLAIN (ANALYZE, BUFFERS)`. It records default-plan index/sort choices and
checks bounded page output and primary-key access for personal lookup. A separate
diagnostic discourages sequential scans, other join strategies and ordinary sorts
to verify an ordered ranking-index path is available; application settings are
unchanged. It explains the underlying ranked-page query because a plain
PL/pgSQL-call explain hides nested plans, and also exercises the real RPCs on the
same dataset with normal settings. Depending on statistics and costs, PostgreSQL
may choose a sequential scan and full-board sort, or either ranking index with
a backward scan and incremental tie sorting. Exact global ranks require scanning
preceding visible scores on deep pages; existing RLS may also scan profiles to
build a visibility lookup. Results
and JSON aggregation are bounded, but database work is not constant-time. Large tie
groups can add sorting work. These checks are a sanity test, not a scale guarantee.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/contracts/` | Authoritative OpenAPI 3.1 contract and derived TypeScript DTOs |
| `packages/cli/` | Local CLI initialization/module staging; future deployment and maintenance |
| `packages/sdk-ts/` | Reserved for the Task 10 client SDK |
| `modules/core/migrations/` | Player profile schema, protected profile functions, RLS and grants |
| `modules/leaderboards/` | Leaderboard/score/event schema, indexes and Edge Function |
| `tests/cli/`, `tests/api/` | CLI process, contract, Deno HTTP and local Edge integration tests |
| `tests/db/`, `tests/fixtures/local/` | pgTAP schema/security suite and isolated local fixture |
| `tests/sdk/`, `tests/e2e/` | Reserved for later local test suites |
| `examples/capacitor-demo/` | Reserved for the standalone Task 11 example |
| `docs/superpowers/` | Product design and numbered implementation plan |

The CLI's `init` and `add leaderboards` commands prepare local files.
`leaderboard`, `deploy`, `doctor` and `upgrade` remain explicit placeholders
that exit unsuccessfully. Games call the HTTP API directly.

## Local CLI setup and module staging

Build with `pnpm --filter @supagame/cli build`. From a developer's existing
Supabase project root, use the resulting executable (or its absolute Node path):

```sh
node /path/to/supagame/packages/cli/dist/cli.js init --project-ref <project-ref> --dry-run
node /path/to/supagame/packages/cli/dist/cli.js init --project-ref <project-ref>
node /path/to/supagame/packages/cli/dist/cli.js add leaderboards --dry-run
node /path/to/supagame/packages/cli/dist/cli.js add leaderboards
```

Both commands accept `--workdir <project-root>`; otherwise only the current
directory is inspected. There is no ancestor-directory search. An empty directory
gets an instruction to run the official `supabase init` first. The toolkit does
not create or link a hosted project, inspect accounts, or run Supabase commands.

`init` records a supplied project reference or reads project-local
`supabase/.temp/project-ref` / `supabase/.temp/linked-project.json` metadata.
These files follow [Supabase's local link conventions](https://supabase.com/docs/guides/local-development/local-and-hosted-projects).
All available references, including an existing manifest, must agree. Missing or
conflicting references fail with corrective instructions. Environment variables
and the local TOML `project_id` never select a remote project. Recording a reference
does not verify that it exists or that the developer has hosted access.

A fresh `supagame.config.json` is:

```json
{
  "formatVersion": 1,
  "projectRef": "abcdefghijklmnopqrst",
  "modules": {},
  "leaderboards": []
}
```

The reference above is a placeholder. Manifest validation rejects unknown fields,
unsupported formats, invalid module/version records and invalid or duplicate board
definitions. Module records map `core` and `leaderboards` to release versions;
installation sets both to `0.1.0`. `leaderboards` is reserved for Task 8's board
creation command. Its validated definition shape is
`{ id, kind, sortDirection, keepBest: true, minValue, maxValue }`, with safe-integer
or null bounds; Task 7 does not create definitions or board SQL.

`add leaderboards` stages all five prerequisite SQL migrations in dependency order
under `supabase/migrations/`, retaining stable versions `20261108000100` through
`20261108000500`. Existing migration version collisions fail even when the suffix
is different. SQL is copied byte for byte and never applied or rewritten. Projects
with newer applied migration versions must review ordering when deployment is
implemented; staging makes no assumption about the remote migration ledger.

The Edge files go under `supabase/functions/supagame/`. The build bundles only an explicit allowlist of its own
module assets, excluding local/hidden files such as `.env`; installation does not
depend on the source checkout. Runtime source
is unchanged. Packaging relocates the type-only DTO import into a copied
`contracts.generated.ts`, and includes a standalone Deno configuration and the
locked dependencies. A built CLI test checks this complete copied graph using
`deno check --frozen` outside the repository.

The CLI parses TOML to validate it, then appends only a missing
`[functions.supagame]` section with `enabled = true`, `verify_jwt = false`, and the
local entrypoint/import-map paths. Existing bytes, comments and line endings are
preserved. An existing compatible section is unchanged; incompatible settings
require manual review. Existing anonymous-auth settings are preserved, with an
instruction if anonymous sign-in is not enabled. Browser clients still need
`SG_ALLOWED_ORIGINS`; the staged `.env.example` contains placeholders only.

Dry runs list `create`, `update`, `unchanged` and `conflict` paths, including active
installer locks, without writing files. Every destination is checked before any
installation writes. Existing identical files are reused, missing files can be
restaged, and modified files or incompatible module versions cause failure.
Repeated successful commands preserve file bytes, modes and modification times;
existing manifests are not rewritten solely to normalize formatting.

Writes use exclusive temporary files, a project-local `.supagame-stage` lock,
atomic file publication and a manifest written last. Caught write failures restore
original files (including their original inode metadata) and remove new files and
empty directories. Concurrent user edits are preserved instead of overwritten
by rollback. Paths reject traversal, symlinks, hard-linked destinations and special
files. Use a canonical project path on a local filesystem supporting hard links
and atomic rename; do not move the project or edit installation files concurrently.
These checks are not a sandbox against a hostile process with the same OS access.

After a process interruption, rerun the same command: stale locks owned by a dead
process on this machine can be cleaned, and identical completed files allow forward
recovery. No untrusted journal is replayed. If ownership cannot be verified, a PID
has been reused, or interruption left a temporary hard link, stop other installers,
inspect `.supagame-stage`, remove only that temporary staging directory, then rerun.
Never commit staging backups. Multiple files are not a power-loss-atomic transaction;
there is no deployment or database operation to undo.

Run `pnpm --filter @supagame/cli test` for CLI, filesystem and built-asset tests.
The CLI tests use temporary directories; the copied Edge typecheck requires the
locked Deno dependencies to be cached or available for download.

## HTTP contract

The [OpenAPI document](packages/contracts/openapi.yaml) defines the base
path `/functions/v1/supagame/v1` on the developer's Supabase project URL.
Every operation requires the project's **publishable** key in the `apikey`
header. Authenticated operations additionally require
`Authorization: Bearer <player-jwt>` for an anonymous or permanent Supabase Auth
user. These requirements are combined, not alternatives.

| Method and path | Player session | Success body |
| --- | --- | --- |
| `GET /leaderboards` | Not required | `LeaderboardSummary[]` |
| `GET /leaderboards/{id}/entries` | Not required | `LeaderboardPage` |
| `GET /leaderboards/{id}/me` | Required | `MyScore` or JSON `null` |
| `POST /leaderboards/{id}/scores` | Required | `SubmitScoreResult` |
| `GET /players/me` | Required | `PlayerProfile` |
| `PATCH /players/me` | Required | `PlayerProfile` |

- Entries use `limit` (1–100, default 50) and an opaque `cursor`. `nextCursor`
  is `null` at the end. Cursors belong to one board. Pages are deterministic
  for unchanged scores; they do not promise a snapshot across concurrent updates.
- `asc` means smaller is better; `desc` means larger is better. One personal best
  is retained. Ties share competition rank (`1, 1, 3`) and display in achievement
  time, then player ID order. Disabled boards and hidden entries are not public.
- Score submissions contain only `{ score, submissionKey }`, where the key is
  a client-generated UUID. Identity comes from the verified session. Retries
  reuse the key and score and return the original result; conflicting reuse
  returns `DUPLICATE_KEY_CONFLICT`.
- JSON scores must satisfy `Number.isSafeInteger(score)`, from
  −9,007,199,254,740,991 to 9,007,199,254,740,991 inclusive, even though PostgreSQL
  stores `BIGINT`. The same bounds apply to returned scores and configured bounds.
- A result is `{ outcome: 'best' | 'not_best', score, bestScore }`. Invalid
  submissions return an HTTP error instead. Every error is a flat
  `{ code: string, message: string }` object; statuses and stable codes are
  documented in OpenAPI. Internal SQL details and credentials must never appear.
- Names are nullable until set; updates trim whitespace and validate 3–24
  printable characters. Request bodies are limited to 4 KiB. The
  submission limit is enforced in SQL at 10 per authenticated identity per board
  per rolling minute.

Edit OpenAPI first when changing a public shape, then run:

```sh
pnpm contracts:generate
pnpm contracts:check
pnpm test
pnpm typecheck
```

Commit the regenerated `packages/contracts/src/generated.ts` with the schema.
Consumers use the named exports from `packages/contracts/src/types.ts` (or
`@supagame/contracts` when linked as a workspace dependency). The generated
types preserve nullability and enum values; TypeScript's `number` type cannot
enforce safe-integer bounds, so runtime validation is still required.

## Edge HTTP API development

The six routes above are implemented in `modules/leaderboards/functions/supagame/`.
Routing, authentication, transport validation and error formatting are separate;
each request delegates its business operation to an existing PostgreSQL function.
RPC types refer to the generated contract DTOs. No database migrations, grants,
RLS policies or score-submission behavior changed for Task 6.

`pnpm install` provisions Deno **2.9.6** through pnpm's pinned runtime support.
Deno dependencies are pinned in `deno.lock`; the auth adapter uses
`@supabase/server` **1.9.2**. The scripts use explicit Deno permissions and frozen
resolution. First use needs network access to download the locked dependencies.

```sh
pnpm test:edge             # Real JWT cryptography; mocked RPC transport, no stack
pnpm check:edge            # Also included in pnpm typecheck
pnpm lint:edge             # Also included in pnpm lint
pnpm api:start             # Dedicated local Auth, gateway, REST, DB and Edge stack
pnpm db:migrate
pnpm test:edge:integration # Raw HTTP against http://127.0.0.1:55431 only
pnpm test:db
pnpm db:stop
```

`api:start` copies the fixture's public `.env.example` into its ignored `.env`
only when absent, and suppresses CLI startup output because it contains privileged
local keys. If a DB-only fixture is already running, stop it before `api:start`.
The integration suite creates anonymous and permanent Auth users, checks all six
routes plus direct REST permissions, and deletes its synthetic users and boards.
It reads local status in memory, uses only the publishable key and user JWTs for
HTTP, and uses the fixed local Docker DB solely for fixture setup/cleanup. It
refuses a non-fixture API URL and never accepts a hosted target.

The local function configuration has `verify_jwt = false`: public and protected
routes share one function. Application authentication uses the supported
[`@supabase/server` core primitives](https://supabase.com/docs/guides/functions/auth)
to verify the publishable key on every non-preflight request to a supported route,
then separately verify a user JWT on protected routes. Those are **both** required,
not an auth-mode alternative. JWT verification checks the signature, issuer,
audience, expiry, authenticated role and UUID subject. The caller-scoped client
forwards the verified user token; public reads always use the anonymous role.
No service-role/admin client is created. This adapter requires modern publishable
keys and JWKS-backed user JWTs supported by the server auth library; legacy anon
keys and legacy shared-secret JWT verification are not supported.

Supabase supplies its URL, publishable keys and JWKS environment. Configure:

- `SG_ALLOWED_ORIGINS`: JSON array of exact browser origins, for example
  `["https://game.example"]`. Default `[]` permits no browser origins; native
  clients without an Origin header still work. Wildcards and `null` origins are
  rejected. Valid OPTIONS preflights require neither API key nor user session.
- `SG_AUTH_ISSUER`: exact Auth JWT issuer if it differs from
  `SUPABASE_PUBLIC_URL` (or `SUPABASE_URL`) plus `/auth/v1`. The local fixture needs
  this because its external Auth URL differs from Docker's internal gateway URL.
  Never derive the trusted issuer from request headers or unverified token claims.

Writes require uncompressed UTF-8 `application/json`; actual streamed bytes are
limited to 4096 even without Content-Length. Unknown fields, identity overrides,
duplicate/unknown query parameters and malformed cursors fail closed. JSON numeric
source text is checked so fractional scores cannot become accepted integers through
floating-point rounding. SQL still owns name normalization, bounds, ranking,
idempotency and throttling. Cursors preserve timestamp microseconds.

Application errors use the OpenAPI `{ code, message }` envelope and no-store
responses. Only known SQLSTATE/message pairs become domain errors; unexpected
errors return a generic 500 without logging credentials or SQL diagnostics.
The contract now also documents 403 CORS/permission failures, 405 with `Allow`,
415 media-type failures, credential-free OPTIONS, and unknown-route 404s.
Supabase's gateway can reject project keys before invoking the function; those
platform-owned error bodies cannot be normalized by this handler. The local Kong
gateway also answers OPTIONS with 200 and wildcard CORS headers before Edge runs;
the handler itself returns 204 with configured origins when preflight reaches it.
Actual requests still enforce the origin allowlist and reject disallowed origins
before authentication or SQL. JWT signature
verification does not immediately revoke an otherwise valid access token after
sign-out; Supabase token expiration and existing database authorization still apply.

## Security and scope

Future installations belong entirely to the developer's Supabase project.
Clients receive only a publishable key and their own session. Never place
privileged credentials in games, fixtures or committed files. Hosted deployment
must preview the exact destination and pending migrations and require explicit
approval. The current implementation performs no hosted operations.

Existing authenticated sessions must be reused. Losing an unlinked anonymous
session may make its identity unrecoverable. Range checks and per-identity rate
limits are abuse mitigations, not complete anti-cheat protection: modified clients
can submit plausible fabricated scores and create additional anonymous accounts.

See the [design](docs/superpowers/specs/2026-11-08-supabase-game-services-design.md)
and [implementation plan](docs/superpowers/plans/2026-11-08-supabase-game-services-v01.md).
The supplied design retains its original draft wording; the plan records its
approval on 2026-11-08. Only Tasks 1–7 are implemented here. Multiplayer, achievements,
cloud saves, friends, seasons, real-time broadcasts, native engine SDKs, and
multi-game tenancy remain outside v0.1.

## Licence

[MIT](LICENSE), copyright 2026 Supabase Game Services contributors.

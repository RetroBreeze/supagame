# Supabase Game Services

An MIT-licensed toolkit for installing modular gaming services into your own
Supabase project. The planned v0.1 provides anonymous player identities and
leaderboards through a versioned HTTP API, a provisioning CLI, and a thin
TypeScript SDK. There is no central service operated by this project.

**Status: Tasks 1–3 implemented.** CLI help, the HTTP contract, shared DTOs,
workspace tooling, database schema and authenticated profile operations are
implemented. Provisioning commands return `not yet implemented` with exit code 1.
Score submission, HTTP handlers and the runtime SDK are future tasks.
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
tests use the local fixture below. Edge Function and end-to-end suites arrive
with their owning tasks; they are not represented by passing placeholder scripts.

TypeScript 5.9.3 is pinned because it is compatible with both the OpenAPI type
generator and TypeScript ESLint. Dependencies are exact versions and the pnpm
lockfile is committed. Packages use ESM, strict typing, and NodeNext resolution;
contracts contain no runtime dependencies. Generated output is ignored.

## Local database tests

Docker must be running. Supabase CLI **3.0.0** is an exact development dependency;
use the repository's scripts so a different global CLI version is not selected.
The fixture in `tests/fixtures/local/supabase/` has project ID
`supagame-schema-tests`, PostgreSQL 17, and database port **55432**. It starts
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
network and both `tests/db/schema.test.sql` and `tests/db/players.test.sql`.
These pgTAP suites create synthetic Auth users and roll back their fixtures and
temporary grants. They check schema constraints, RLS, grants, profile operations,
name validation and actual allowed/denied queries as `anon` and as `authenticated`
with both anonymous and permanent user claims. This tests database authorization;
JWT verification and HTTP behavior belong to later tasks.

After pgTAP, `pnpm test:db` also runs `pnpm test:db:concurrency`. This uses Docker
to open two real `psql` sessions in the fixed local fixture container. Each case
holds the first profile insert uncommitted and verifies the second request is
waiting on a database lock before releasing it. All four get/update combinations
must return one consistent profile. Synthetic users for these cases are committed
so both sessions can see them, then deleted in `finally` cleanup. Server timeouts
bound failed tests. The harness does not accept a hosted database connection.

`pnpm db:stage` copies module migrations into the fixture's ignored migrations
directory with stable, globally unique versions. Core tables come before
leaderboards, followed by the new profile functions. Existing identical copies
are left alone; differing copies fail
instead of overwriting them. The migration ledger makes repeated installation
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
  with an index for the future rate-limit window. No submission logic runs yet.

RLS permits reads of enabled boards, visible profiles and their scores. Explicit
column grants keep moderation flags and submission keys out of public reads.
Neither API role can insert, update, delete, truncate, or create foreign keys or
triggers against these tables. The private schema has no API-role access, is excluded
from the fixture's exposed schemas, and its event table also has default-deny RLS.
Migrations revoke Supabase's automatic client grants on these tables without
changing privileges on unrelated application objects.

Scores and bounds use `BIGINT` constrained to JSON-safe integers. Trusted deletion
of an Auth user or board cascades to dependent toolkit records, preventing
orphans. There are no client delete permissions. Board-specific submission
validation, atomic best-score updates, idempotent replay and rate limiting remain
the responsibility of subsequent tasks.

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

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/contracts/` | Authoritative OpenAPI 3.1 contract and derived TypeScript DTOs |
| `packages/cli/` | CLI entrypoint; future provisioning and maintenance commands |
| `packages/sdk-ts/` | Reserved for the Task 10 client SDK |
| `modules/core/migrations/` | Player profile schema, protected profile functions, RLS and grants |
| `modules/leaderboards/` | Leaderboard/score/event schema and indexes; future Edge Function |
| `tests/cli/`, `tests/api/` | CLI process tests and contract/schema tests |
| `tests/db/`, `tests/fixtures/local/` | pgTAP schema/security suite and isolated local fixture |
| `tests/sdk/`, `tests/e2e/` | Reserved for later local test suites |
| `examples/capacitor-demo/` | Reserved for the standalone Task 11 example |
| `docs/superpowers/` | Product design and numbered implementation plan |

The CLI's `init`, `add`, `leaderboard`, `deploy`, `doctor`, and `upgrade`
commands currently expose help only. The CLI is for developer provisioning;
games will call HTTP endpoints or the SDK directly.

## HTTP contract

The [OpenAPI document](packages/contracts/openapi.yaml) defines the future base
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
  printable characters. Request bodies are limited to 4 KiB. The planned
  submission limit is 10 per authenticated identity per board per rolling minute.

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
approval on 2026-11-08. Only Tasks 1–3 are implemented here. Multiplayer, achievements,
cloud saves, friends, seasons, real-time broadcasts, native engine SDKs, and
multi-game tenancy remain outside v0.1.

## Licence

[MIT](LICENSE), copyright 2026 Supabase Game Services contributors.

# Supabase Game Services

An MIT-licensed toolkit for installing modular gaming services into your own
Supabase project. The planned v0.1 provides anonymous player identities and
leaderboards through a versioned HTTP API, a provisioning CLI, and a thin
TypeScript SDK. There is no central service operated by this project.

**Status: Task 1 bootstrap only.** CLI help, the HTTP contract, shared DTOs,
workspace tooling and initial tests are implemented. Provisioning commands
return `not yet implemented` with exit code 1. Database migrations, HTTP
handlers and the runtime SDK are future tasks. Nothing is deployed or published.
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
No Supabase credentials, Docker stack or hosted project is needed for Task 1.
Database, Edge Function and end-to-end suites arrive with their owning tasks;
they are not represented by passing placeholder scripts.

TypeScript 5.9.3 is pinned because it is compatible with both the OpenAPI type
generator and TypeScript ESLint. Dependencies are exact versions and the pnpm
lockfile is committed. Packages use ESM, strict typing, and NodeNext resolution;
contracts contain no runtime dependencies. Generated output is ignored.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/contracts/` | Authoritative OpenAPI 3.1 contract and derived TypeScript DTOs |
| `packages/cli/` | CLI entrypoint; future provisioning and maintenance commands |
| `packages/sdk-ts/` | Reserved for the Task 10 client SDK |
| `modules/core/migrations/` | Reserved for player profiles and security migrations |
| `modules/leaderboards/` | Reserved for leaderboard migrations and the Edge Function |
| `tests/cli/`, `tests/api/` | CLI process tests and contract/schema tests |
| `tests/db/`, `tests/sdk/`, `tests/e2e/` | Reserved for later local test suites |
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
approval; Task 1 performs no hosted operations.

Existing authenticated sessions must be reused. Losing an unlinked anonymous
session may make its identity unrecoverable. Range checks and per-identity rate
limits are abuse mitigations, not complete anti-cheat protection: modified clients
can submit plausible fabricated scores and create additional anonymous accounts.

See the [design](docs/superpowers/specs/2026-11-08-supabase-game-services-design.md)
and [implementation plan](docs/superpowers/plans/2026-11-08-supabase-game-services-v01.md).
The supplied design retains its original draft wording; the plan records its
approval on 2026-11-08. Only Task 1 is implemented here. Multiplayer, achievements,
cloud saves, friends, seasons, real-time broadcasts, native engine SDKs, and
multi-game tenancy remain outside v0.1.

## Licence

[MIT](LICENSE), copyright 2026 Supabase Game Services contributors.

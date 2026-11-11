# Supabase Game Services — Agent Instructions

This repository contains **Supabase Game Services**, an MIT-licensed, open-source toolkit that installs reusable gaming services into developers' own Supabase projects. The first release provides anonymous player identities and leaderboards. Developers provision services with a CLI; games use a versioned HTTP API or a thin language SDK.

## Source of truth

Read these files before implementing a task:

1. `docs/superpowers/specs/2026-11-08-supabase-game-services-design.md` — approved product and technical design.
2. `docs/superpowers/plans/2026-11-08-supabase-game-services-v01.md` — task order, exact interfaces, tests and acceptance criteria.
3. The relevant source files, tests and existing repository conventions.

If either document is absent, ask for it rather than reconstructing requirements from memory. The task given by the user takes precedence over the plan when the user explicitly changes scope. Flag contradictions before making a consequential design change.

## Working agreement

- **One implementation task per request.** Complete only the requested numbered plan task, then stop. Do not automatically proceed to the next task, even if time remains.
- Follow test-driven development: add a failing test, observe failure, implement the smallest correct change, then verify the test passes.
- Run the relevant typecheck, lint, unit, database and integration checks before claiming success. Report exactly what ran and any checks that could not run.
- Make a focused Git commit for a verified task when the user has authorized committing. Never include unrelated or pre-existing changes in the commit.
- Preserve existing user edits. Inspect `git status` before making changes; never use destructive Git resets or checkout commands on user work.
- Do not spawn subagents, run parallel implementation agents, or start long-running unattended work unless the user explicitly asks.
- If a task is blocked, explain the blocker and stop. Do not work around permissions, secrets, production restrictions or missing required decisions.
- Prefer straightforward, maintainable TypeScript and SQL. Keep modules small, typed and independently testable. Avoid speculative abstractions or unrelated refactoring.

## Scope for v0.1

**Included:** CLI installation/configuration, Supabase Auth anonymous identities, player display names, ascending/descending best-score leaderboards, atomic score submission, read/rank API, basic server-side validation/rate limiting, TypeScript SDK, tests and documentation.

**Excluded:** multiplayer, achievements, cloud saves, friends, seasons, replay verification, real-time score broadcasts, a hosted dashboard, native Unity/Godot SDKs and multi-game tenancy. Do not add these without a separate approved design.

- Each installation belongs to the developer's Supabase project. Never build a centralized service owned by this project.
- Anonymous authentication is the default for users without a session. Reuse an existing Supabase Auth session; never silently replace an authenticated user with an anonymous one.
- The CLI is for provisioning and maintenance, not game runtime traffic.
- The HTTP API is the stable, engine-independent interface. The TypeScript SDK is a convenience wrapper, not the only way to use the backend.
- One best score per player per leaderboard; `asc` means smaller is better, `desc` means larger is better. Equal scores share the same competition rank, with deterministic display ordering.
- PostgreSQL stores scores as `BIGINT`. JSON/JavaScript scores must be safe integers to avoid precision loss.

## Architecture and ownership

- `packages/contracts/`: OpenAPI 3.1 contract and shared DTOs. Treat it as the source of truth for public request/response shapes.
- `packages/cli/`: setup, module staging, leaderboard configuration, deployment, diagnostics and upgrades.
- `modules/core/`: player profiles, database policies, SQL helpers.
- `modules/leaderboards/`: versioned SQL migrations and Supabase Edge Function routes.
- `packages/sdk-ts/`: client-side TypeScript SDK using an existing Supabase client for Auth.
- `tests/`: database, API, CLI, SDK and end-to-end tests.
- `examples/`: minimal standalone integration example. Do **not** modify the real Toy Tanks project as part of this SDK unless separately requested.

Follow existing conventions once the repository has evolved; the implementation plan may use provisional paths and names. Keep the public API contract, SQL interfaces, SDK interfaces and documentation synchronized with any approved change.

## Supabase security rules

- Never put a `service_role` key, secret API key, database password, personal access token or other privileged credential in a game client, committed file, test fixture or log. `.env.example` contains placeholders only.
- Derive a submitting player's identity from a verified Supabase Auth JWT / `auth.uid()`, never a client-supplied `playerId`.
- Use Row Level Security, minimum grants and narrowly scoped SQL functions. No direct client INSERT/UPDATE/DELETE permissions on protected score or configuration tables.
- Treat every `SECURITY DEFINER` function as security-sensitive: fixed safe `search_path`, explicit authorization checks, narrow EXECUTE grants and tests for cross-user access.
- Use the caller-scoped Supabase client for player requests. Do not bypass RLS with admin credentials for ordinary reads or score submissions.
- Enforce score bounds, valid board state, idempotency and rate limiting on the trusted server/database side. Updates must be transactional and must never worsen a personal best under concurrent submissions.
- Never describe range checks or rate limits as complete anti-cheat protection. Modified clients can still submit plausible fabricated scores.
- Validate request sizes, pagination limits, display names and public error responses. Don't leak internal SQL details or tokens.
- Treat public read routes separately from authenticated write/profile routes; test that missing, invalid or expired credentials fail closed where authentication is required.

## Database migrations and CLI deployment

- Generate and keep additive, versioned migrations in Git. Never edit a migration that may have been applied; add a new migration instead.
- CLI installation and upgrades must be repeatable and must not overwrite unrelated project files.
- **Local tests first.** Use a local Supabase stack and synthetic users. Do not require production Supabase credentials for automated tests.
- Detect and print the exact project reference and all pending migrations before deploying.
- Supabase CLI v3 database commands target the local stack by default. For hosted operations use an explicit `--remote=<project-ref>` target. Check the installed CLI version and flags rather than assuming legacy behavior.
- Hosted writes require explicit user approval. Do not run `supabase db push --remote`, `functions deploy`, `config push`, or equivalent hosted mutations merely because a test or task mentions them.
- Never run remote `db reset`, delete/prune hosted functions, drop user data, or automatically publish npm packages or GitHub releases without separate authorization.
- If the CLI automates a hosted operation, it must first verify its destination, preview changes, obtain explicit confirmation, and only then pass any noninteractive approval flag to the underlying Supabase CLI.

## Testing expectations

Cover behavior and security, not only happy-path types. In particular:

- Fresh installation, repeated installation and safe upgrades.
- Anonymous sign-in, existing-session reuse and lost-session behavior.
- Ascending/descending scores, best-only updates, ties, stable ranks and page cursors.
- Simultaneous score submissions, duplicate idempotency keys and throttling.
- Public reads, unauthorized writes, expired JWTs, RLS isolation and hidden player entries.
- Wrong Supabase project selection and declined/unattended deployment confirmation.
- Raw HTTP compatibility as well as TypeScript SDK behavior.

Use the relevant test command listed in the plan. For a full release candidate, run the repository's database tests, API/CLI/SDK unit tests, typechecks, build and local end-to-end suite. Never report tests as passing unless their actual output confirms it.

## End-of-task report

After completing the requested task, report concisely:

1. Files/components changed and the behavior delivered.
2. Test and verification commands, with pass/fail results.
3. Any architectural decisions, plan deviations or limitations.
4. Git commit hash, if committed.
5. Remaining blockers or follow-up work.

**Then stop and wait for the user's review. Do not generate or execute the next task automatically.**

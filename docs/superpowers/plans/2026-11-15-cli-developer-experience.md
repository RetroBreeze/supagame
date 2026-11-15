# CLI developer experience implementation plan

> Execute inline with superpowers:executing-plans. No subagents. The user waived design review and authorized the complete overhaul, staged commits, and local verification.

**Goal:** Guided, engine-neutral setup with equally reliable explicit automation.

**Architecture:** Keep the manifest, validators, file transaction and hosted deployment state machine. Add injectable terminal/prompt services and structured output at the command boundary. Compose initialization and selected modules into one file transaction. Public connection exports are derived snapshots, never deployment configuration.

**Tech stack:** Existing TypeScript, Commander, Node readline, Vitest, Python standard-library PTYs; no new production dependencies.

**Spec:** User's “Supagame v0.1.0 — CLI Developer Experience Overhaul” request, superseding the original narrower v0.1 scope. Existing security design remains binding.

## Constraints and decisions

- Node 24/26, Supabase 3.0.0/3.1.0. Preserve the dependency pin and private flags.
- Work on `feat/cli-developer-experience`; retain pre-existing uncommitted example relocation, README, lockfile and test edits. Stage only task-owned changes.
- No hosted deployments, publication, pushes, production SQL/Edge changes or generated client code.
- Keep `supagame.config.json` formatVersion 1; all selected services currently require core/leaderboards. Show dependencies explicitly.
- Explicit commands retain defaults: omitted score bounds mean unbounded; keep-best remains required in explicit automation and always true in guided setup.
- Interactive only with input/output TTY, no CI, no JSON and no `--no-interactive`. Fully specified invocations bypass prompts. `--interactive` explicitly requests optional setup questions.
- JSON output is a versioned command envelope with structured events/results and categorized errors. Retain existing Admin inspection JSON unchanged. Preserve doctor exit codes 0/1/2 and existing failure code 1; cancellation uses 130.
- Connection schemaVersion 1: projectRef, supabaseUrl, publishableKey, apiBaseUrl. Only modern publishable keys, matching the current runtime. No inferred key, privileged key, JWT or arbitrary credential accepted. Explicit custom URLs require project-bound validation. Export is optional, safe, and never read as deployment authority.
- Wiki edits remain local until push authorization.

## Review focus

1. EOF/SIGINT during any prompt leaves project files untouched and closes readline.
2. A CI/JSON flag cannot accidentally authorize hosted writes or launch login.
3. Multiple module selections are one transaction with the manifest last; failed writes roll back.
4. Malformed discovery/key responses and terminal control characters cannot leak subprocess output or forge terminal UI.
5. Concise deployment/doctor output retains every pending migration, actionable warning, uncertainty and authorization boundary.

## Stages

### 1. Terminal UI and prompting

Files: new `src/lib/terminal.ts`, `src/lib/prompts.ts`, tests `tests/cli/terminal.test.ts`, `prompts.test.ts`.
Interfaces: typed output events; context-scoped reporter; injectable line input with text/select/multiselect/confirm/integer methods; cancellation error.
- [x] Write regressions for TTY/CI/NO_COLOR, JSON integrity, defaults, validation, cancellation and invalid choices; observe failure.
- [x] Implement terminal/prompt services with bounded input and no decorative animation outside a terminal.
- [x] Run targeted Vitest and CLI typecheck/lint; commit verified stage.

### 2. Guided definition commands and automation boundary

Files: CLI registration, leaderboard/achievement commands, file-stage reporting; new command runner and creation workflows.
- [x] Tests: explicit flags bypass prompts, missing flags fail unattended, guided validation and summaries, dry runs, immutable definitions and cancellation preserve bytes.
- [x] Extract plan preparation from create commands; reuse existing definition/SQL validation. Route output through the reporter; structured JSON includes file statuses, definitions and diagnostics, never file contents.
- [x] Keep existing Admin JSON contract and mutation consent; apply global non-interactive control to all confirmation paths.
- [x] Run CLI unit/typecheck/lint and commit.

### 3. Guided init and public connections

Files: init/add plan composition, `lib/setup-environment.ts`, `lib/connection.ts`, `commands/connection.ts`, guided initialization workflow.
- [x] Tests: dependency resolution, atomic rollback, existing config/link conflicts, missing executable/version/auth, malformed project/key data, optional origins, public-only export/replacement, custom URLs and dry-run cancellation.
- [x] Inspect actual supported CLI discovery/API-key JSON using synthetic loopback responses; implement strict parsers and closed-stdin isolated subprocesses. Offer normal CLI login only interactively with explicit consent.
- [x] Compose all local changes before preview/confirmation; optional export belongs to the same transaction. Preserve legacy explicit offline initialization.
- [x] Provide `connection` display and `--output` export with explicit replacement, safe paths and project identity checks.
- [x] Run targeted/unit/typecheck/lint and commit.

### 4. Consistent command presentation and PTY coverage

Files: deploy/doctor and remaining command presentation; PTY tests and compatibility fixtures.
- [x] Tests: migration/diagnostic detail survives concise output and JSON; no raw subprocess credentials; no-TTY/CI/JSON never wait; actual PTY guided and explicit invocation, EOF/SIGINT.
- [x] Present headings, summaries, structured stages and static progress with optional detailed diagnostics. Keep hosted mutation ordering, confirmation revalidation and recovery logic intact.
- [x] Run CLI regression suite, compatibility and packaging checks; commit.

### 5. Documentation and release verification

Files: root/CLI READMEs, local Wiki Quickstart/Installation-Reference/Troubleshooting, verification record and CI commands.
- [ ] Document guided and explicit engine-neutral sessions, JSON schema/exit codes, optional connection exports, prerequisites and diagnostic limitations.
- [ ] Run full build/typecheck/lint/contracts/unit/Edge/package/database/API/SDK/E2E suite under all four Node × CLI combinations. Record exact results and blockers; never label simulated APIs hosted verification.
- [ ] Self-review complete diff against request and security constraints (user prohibits subagents). Verify user edits remain excluded. Commit documentation/verification separately, no push.

## Execution record

- Inspection: command registration, init/add/create/deploy/doctor/auth/admin, manifest, planner rollback, Supabase process boundary and compatibility/E2E tests reviewed. Existing source uses direct console output and several independent confirmation implementations.
- Existing CLI baseline: 343 tests passed. Stage 1: 14 terminal/prompt tests, CLI typecheck and lint passed. Stage 2: complete CLI suite 364 tests passed; focused creation/help regressions 40 passed; CLI typecheck/lint passed. Native Node execution caught parameter-property syntax, corrected to erasable TypeScript.
- Ruling: work in the requested feature branch in the current checkout, preserving all user edits; no additional worktree or dependency reinstall needed.

- Stage 3: combined init/module plans, public-key/custom-domain discovery and safe exports verified. Additional export-path and target-drift regressions were observed failing, then passed. Commit `0060381`.
- Stage 4: concise deployment/doctor output and 7 Linux PTY regressions verified. The PTY harness needed a bounded wait between terminal closure and child reaping under full-suite load. Commit `755e779`.
- Whole-suite checkpoint: 641 unit tests passed before the 5 export-boundary additions; all workspace/Edge typechecks, lint, build and package tests passed. Matrix is now running against the final formatted implementation.
- Ruling: no subagent review because the user's repository instructions prohibit subagents. Performed a separate author security/requirements review; export destination and project-drift findings were fixed with failing regressions.
- Environment: the pre-existing local stack lacked its Edge Runtime, producing 12 HTTP integration failures (503). Started only the local fixture's function server; rerun passed all 13 HTTP steps. Existing database containers were preserved. No production/hosted changes.
- Auth/domain transport was checked using real Supabase binaries and synthetic loopback responses, including the documented hostname API response. Actual hosted login, key/domain permissions and custom-domain TLS remain unverified.

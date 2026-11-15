# CLI developer experience verification

Verified on 2026-11-15 on `feat/cli-developer-experience`, based on `e1ab672`.
**GO for the subsequent v0.1.0 release audit.** This is not publication approval.
Packages remain private; no push, release tag, publication or hosted deployment
was performed.

## Delivered behavior

- Shared terminal presentation, injectable prompts, explicit unattended mode,
  versioned JSON envelopes and categorized errors. CI and redirected input/output
  never prompt; complete commands retain their explicit behavior.
- Guided initialization checks prerequisites and account access, offers the normal
  Supabase login flow, selects or accepts a project, resolves actual module
  dependencies, and optionally configures browser origins and public connections.
  One preview and one existing file transaction cover all local changes.
- Leaderboard and achievement creation prompt for missing settings, reuse existing
  validation and immutable migration rules, and support cancellation and dry runs.
- Public connection display/export validates project identity, publishable keys,
  URLs, destinations and replacement. Exports are optional derived snapshots.
- Concise deploy/doctor presentation retains pending migrations, warnings,
  verification limitations, explicit hosted authorization and detailed diagnostics.

No client framework files or engine SDKs are generated. Native engines can skip
browser origins. The existing TypeScript SDK remains independent. Production SQL,
Edge Functions, SDK/contracts, package privacy flags and dependency pins are
unchanged by these commits.

## Example sessions

```text
$ npx supagame init
SUPAGAME · INIT
? Supabase project: My Arcade (abcdefghijklmnopqrst)
? Which Supagame services would you like?: achievements
Selected services include their Core and Leaderboards prerequisites.
? Configure browser origins? Native engines can skip this. (y/n) [n]: n
? Export public connection information as JSON? (y/n) [n]: n
SUPAGAME · READY TO INITIALIZE
Reference   abcdefghijklmnopqrst
Modules     core, leaderboards, achievements
create supabase/migrations/...
create supabase/config.toml
create supagame.config.json
? Apply configuration? (y/n) [y]: y
```

The excerpt abbreviates the file list. Guided definitions use the same preview and
confirmation flow:

```sh
npx supagame leaderboard create target-rush
npx supagame achievement create first-win
npx supagame connection --json
npx supagame connection --output supagame.connection.json --dry-run
```

Equivalent explicit creation bypasses prompts:

```sh
npx supagame leaderboard create target-rush --type points --order desc --keep-best --min 0 --max 1000000 --no-interactive --json
```

See the [CLI guide](packages/cli/README.md) for complete examples, flags, JSON fields,
exit codes, safe replacement rules and troubleshooting. Packages are still
unpublished: use the repository's local tarball workflow before release.

## Architecture and file inventory

New production files below are relative to `packages/cli/src/`:

| File | Responsibility |
| --- | --- |
| `lib/terminal.ts` | Scoped human/JSON reporter, events, safe terminal formatting |
| `lib/prompts.ts` | Injectable validated prompts, TTY/CI gating, EOF/SIGINT handling |
| `lib/cli-error.ts` | Typed command failure categories |
| `lib/module-plan.ts` | Reusable module dependency and template planning |
| `lib/setup-environment.ts` | Supported versions, authenticated CLI discovery, normal login |
| `lib/connection.ts` | Public connection schema, URL/key validation, safe export planning |
| `lib/presentation.ts` | Deploy previews and diagnostic summaries |
| `commands/guided-create.ts` | Missing-option leaderboard/achievement workflows |
| `commands/guided-init.ts` | Guided setup and atomic plan composition |
| `commands/connection.ts` | Public display/export command and target revalidation |

Existing init/add/definition commands expose reusable plan builders. The command
boundary controls JSON and interaction. File staging still owns conflict checks,
rollback and manifest-last application. Deployment's state machine, consent,
revalidation, scoped mutations, journals and uncertain-outcome handling remain in
place. Admin inspection JSON retains its existing contract. No new production
dependencies were added.

New tests under `tests/cli/`: `terminal.test.ts`, `prompts.test.ts`,
`guided-create.test.ts`, `guided-init.test.ts`, `setup-environment.test.ts`,
`connection.test.ts`, `presentation.test.ts`, `interactive.test.ts` and
`pty-driver.py`. Existing real-binary compatibility fixtures were extended.

Documentation changes: root and CLI READMEs, `docs/README.md`, the
[implementation plan](docs/superpowers/plans/2026-11-15-cli-developer-experience.md),
this record, and the local Wiki's CLI, Quickstart, Installation Reference,
Troubleshooting and sidebar pages.

## Complete compatibility matrix

| Node.js | Supabase CLI | Result | Command runs |
| --- | --- | --- | --- |
| 24.22.3 | 3.0.0 | PASS | 15/15 |
| 24.22.3 | 3.1.0 | PASS | 15/15 |
| 26.13.0 | 3.0.0 | PASS | 15/15 |
| 26.13.0 | 3.1.0 | PASS | 15/15 |

All **60/60** final command runs exited 0. Each matrix entry ran these exact
commands in this order; counts below are **per entry**, not aggregated:

| Command | Result |
| --- | --- |
| `pnpm build` | All workspace builds passed |
| `pnpm typecheck` | Workspace and Edge typechecks passed |
| `pnpm lint` | ESLint and Edge lint passed |
| `pnpm contracts:check` | Passed |
| `pnpm test` | 646 tests in 44 files passed, including 7 real PTY tests |
| `pnpm test:cli:compatibility` | 2 actual-binary/loopback tests passed |
| `pnpm test:edge` | 84 tests passed |
| `pnpm test:packages` | 2 tests passed, including fresh tarballs and isolated consumer |
| `pnpm db:migrate` | Passed; no pending fixture migrations |
| `pnpm test:db` | 809 pgTAP checks in 11 files, 2 Admin and 21 concurrency tests passed |
| `pnpm test:cli:db` | 31 tests passed |
| `pnpm test:edge:integration` | 1 test with 13 HTTP steps passed |
| `pnpm test:sdk:integration` | 13 tests in 2 files passed |
| `pnpm test:cli:db` | Repeated after integration: 31 tests passed |
| `pnpm test:e2e` | 15 tests passed; fresh install, HTTP/SDK, Chromium, realtime and Admin |

The runner checked `node --version` for each entry and selected official,
checksum-verified Supabase binaries using
`node scripts/select-test-supabase.ts <version>`. Environment: Linux x86_64,
pnpm 12.18.0, Deno 2.9.6, `NO_COLOR=1`. Node 24.22.3 was downloaded from the
official distribution and checksum-verified. Node 26.13.0 was installed locally.
The generated test executable was restored to Supabase 3.0.0 afterward; the
repository's pinned dependency never changed.

Raw local evidence: `/tmp/supagame-dx-matrix/results.json` and its per-command
logs. These temporary logs are not committed or portable artifacts. This record
contains the durable command/result summary.

## Test boundaries and resolved failures

Unit regressions cover interactive/unattended invocation, complete commands,
validation, cancellation, CI/no-TTY, dry runs, file preservation/rollback,
conflicting project references, unsupported versions, authentication failures,
malformed discovery, privileged-key rejection, public exports, JSON integrity,
NO_COLOR, diagnostics and existing deployment safeguards. Seven Python
standard-library PTY scenarios exercise the actual Node CLI, including guided
creation/init, invalid input, Ctrl-C, EOF and prompt bypass.

Tests used real local PostgreSQL, Auth and Edge Runtime services with synthetic
users. Compatibility tests used actual Supabase 3.0.0/3.1.0 executables against
synthetic loopback Management API responses for project/key/domain discovery and
scoped upload. These are **simulated hosted API tests, not hosted verification**.

Tests were added and observed failing before implementation. Additional failures
found and resolved during verification:

- Native Node execution rejected TypeScript parameter properties; implementation
  now uses erasable syntax.
- The PTY harness initially raced terminal closure against child reaping under
  full-suite load; it now waits within the original bounded timeout.
- A local Supabase wrapper failed the isolated executable compatibility check;
  selecting the official supported binary resolved the environment mismatch.
- The existing local stack had no Edge Runtime, causing 12 HTTP steps to return
  503. Starting the local fixture function server made all 13 steps pass. That
  server was stopped after verification; pre-existing stack containers were kept.
- Export destination and project-drift review findings received failing
  regression tests before their fixes.

## Commits and review limitations

| Commit | Stage |
| --- | --- |
| `ef9da31` | Shared terminal and prompt services |
| `7848d6d` | Guided definitions and automation boundary |
| `0060381` | Atomic guided setup and public connection exports |
| `755e779` | Diagnostics presentation and real terminal workflows |
| `d097356` | Formatting |
| `513fcfb` | Public CLI documentation |

This verification record and completed plan are committed separately after those
changes. The Wiki checkout at `../supagame.wiki` has local commit `7db945e` on
the same feature branch. Neither repository was pushed, so the hosted Wiki is
not updated yet.

The matrix ran against the working tree, including the user's pre-existing,
uncommitted Target Rush relocation, README, lockfile and related test changes.
Those changes were preserved and excluded from these commits. This is not a
claim that the feature commits alone reproduce that entire working-tree result;
the release audit must reconcile and verify the intended final release tree.

Actual hosted browser login, hosted key/domain permissions, custom-domain TLS and
hosted deployment were not exercised. Custom URLs support verified active
Supabase custom domains; arbitrary proxies and vanity domains fail closed.
Windows/macOS were not tested. Review was a separate author requirements/security
pass; no independent agent review was performed because repository instructions
prohibit subagents.

Proceed to the release audit with those boundaries explicit. Publication remains
disabled, and any hosted smoke test or push requires separate authorization.

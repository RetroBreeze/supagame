# v0.1 verification and release gates

Task 11 was implemented on `task-11-release-readiness`, based on Task 10 correction
`65aecd6eafd21e7a49ff201f5da039f417184aa9`. Verification below was executed locally
on 9 November 2026 with Node 24.22.2, pnpm 12.18.0, Supabase CLI 3.0.0, Deno 2.9.6,
PostgreSQL 17 and Playwright 1.65.0/Chromium. No hosted credentials, deployment,
npm publication or public release were used.

## Verification command record

Commands were run from the repository root using the pinned toolchain on PATH.
These are the verification/setup commands executed, including their outcomes;
filesystem/source inspection and Git review commands are not test claims.

| Command | Outcome |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; all five workspace projects, unchanged lock resolution |
| `pnpm test` | PASS; 270 tests: 132 CLI, 36 API contract, 94 SDK, 8 demo config |
| `pnpm -r test` | PASS; the same four component suites through package scripts |
| `pnpm exec vitest run tests/demo/config.test.ts` | Initial expected missing-module failure; then PASS, 8 tests |
| `pnpm typecheck` | PASS; root tests/tooling, every package/example and frozen Deno Edge checks |
| `pnpm lint` | PASS; ESLint plus Deno lint/format checks |
| `pnpm -r build` | PASS; CLI/assets, contract DTOs, SDK/declarations and Vite browser assets |
| `pnpm --filter @supagame/capacitor-demo build` | PASS; used to isolate the clean-consumer config failure |
| `pnpm contracts:check` | PASS; generated OpenAPI DTOs and standalone SDK validators current |
| `pnpm test:edge` | PASS; 80 Edge HTTP/auth/validation tests |
| `pnpm test:packages` | PASS; clean tarball installation, executable CLI, SDK exports, declarations and browser bundling |
| `pnpm exec playwright install chromium` | PASS; pinned Chromium available (system dependencies already available locally) |
| `pnpm api:start` | PASS; existing isolated regression fixture started, privileged status output discarded |
| `pnpm db:migrate` | PASS; fixture migrations staged/applied through local CLI |
| `pnpm test:db` | PASS; 691 pgTAP assertions and 18 real PostgreSQL concurrency tests |
| `pnpm test:cli:db` | PASS; 16 migration/maintenance/local CLI protocol tests |
| `pnpm test:edge:integration` | PASS; one real local integration suite, 12 steps |
| `pnpm test:sdk:integration` | PASS; 7 real Supabase SDK/Auth/RLS checks |
| `pnpm db:stop` | PASS; only the stable regression fixture stopped |
| `pnpm test:e2e` | PASS; one parent workflow and 8 subtests (9 reported tests), fresh isolated stack and real Chromium |
| `actionlint .github/workflows/ci.yml` | PASS using actionlint 1.7.7 installed outside the repository |
| `git diff --check` | PASS |

Dependency/setup verification also ran `pnpm view playwright version`,
`pnpm view vite@8.3.6 version`, `pnpm add -Dw playwright@1.65.0`, and `pnpm install`
successfully. `pnpm exec deno check --frozen=false ...` updated only the root
workspace dependency inventory; the subsequent frozen check passed. The pinned
Supabase `start`, `stop` and `init --help` commands were inspected successfully.
Action tag SHAs were verified with `git ls-remote` against the official repositories;
`go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7` succeeded outside the
checkout. No action ran remotely during this task.

The package/E2E harness also successfully executes these commands in disposable
consumer directories (never publishes):

- `pnpm pack --pack-destination <temporary-directory>` for CLI, contracts and SDK.
- `tar -tzf <archive>` to check required files, license and exclusions.
- `npm install --ignore-scripts --no-audit --no-fund <three-tarballs> @supabase/supabase-js@2.119.0 typescript@5.9.3 @types/node@24.19.2`.
- Installed `supagame --help`, `init`, `add leaderboards` twice, both leaderboard
  creation commands and repeated identical creation, plus `doctor --local`.
- Clean consumer `tsc --noEmit --strict --target ES2022 --module NodeNext --lib ES2022,DOM consumer.ts`.
- Browser bundling through esbuild's API and pinned `vite build <copied-demo>`.
- Supabase `init --yes`, `start`, `migration up`, `status --output json` and
  `stop --project-id <owned-id> --no-backup`, all with the explicit temporary
  `--workdir` and test-owned `--network-id`; no remote flags.
- Docker creation/removal of that exact loopback-bound network. Inspection after
  completion found no leftover E2E containers, volumes or networks.

## Red/green findings and corrections

The initial E2E failed on the missing example, and the new demo configuration
suite failed before the configuration validator existed. The first package test
also exposed a **test-harness** bug: the contracts package legitimately has no
runtime dependencies, so its metadata check needed an empty-object default.
An initial typecheck caught an unused test import; it was removed.

The fresh backend lifecycle passed immediately against Tasks 1–10. The copied
browser consumer then caught a relative `tsconfig.base.json` dependency on the
repository. The demo now has a standalone TypeScript config. A subsequent run
encountered an occupied port 5173; no existing service was touched, and the browser
fixture now uses an ephemeral port alongside its other isolated ports.

A real browser rate-limit regression failed because the demo retained a definitively
rejected attempt as uncertain, blocking a later different submission. The minimal
fix clears the pending attempt on structured 4xx rejection, while retaining its
key for uncertain network/5xx outcomes. The full Chromium workflow then passed.
A final declaration check without `skipLibCheck` exposed NodeJS/Buffer type
references in the pinned Supabase peer's storage/transport declarations. The clean
consumer now installs pinned `@types/node` as a type-checking dependency and checks
all declarations without suppressing those errors. Quickstart/API docs explain this
development dependency; no Node runtime polyfills or SDK changes were introduced.
All failures above were addressed; none are hidden as skipped tests.

## Self-review and deviations

- No Task 1–10 runtime code, database migration or public API contract was changed.
  Existing security, concurrency, CLI and HTTP suites pass unchanged.
- The browser example is a small vanilla TypeScript/Vite form, not a game. Capacitor
  configuration points at built web assets; there are no generated native projects.
- E2E uses tarballs for CLI/contracts/SDK and installs outside the repository.
  Development tools run from the pinned workspace; runtime SDK imports resolve
  from the isolated consumer's installed package.
- E2E owns a unique project ID/network, temporary directories and loopback ports.
  Normal success/failure and handled interrupts clean only those resources. A hard
  kill/host crash can still require targeted manual cleanup, documented separately.
- The old design's Toy Tanks reference is superseded by the requested standalone
  demo. Neither Toy Tanks nor Vaccoin was modified.
- Local email/password conversion is tested with confirmations disabled only in
  the disposable fixture. Provider OAuth and production email delivery are not
  simulated as successful integrations.
- GitHub Actions workflow syntax is validated and its commands ran locally. An
  actual GitHub-hosted workflow run remains unverified until pushed/run separately.
- No destructive migration, automatic retention job, publishing automation or
  hosted deployment was added. Packages remain private and MIT licensed.

## Remaining release gates

There are no known failing local checks. Before a separately approved public release:

1. Confirm the provisional `@supagame/*` names/ownership and final repository,
   support and package metadata. Review versioning and deliberately remove private
   publication guards only as part of that authorization.
2. Run the committed CI workflow on the target GitHub repository/runner.
3. Perform an explicitly authorized staging-project deployment verification,
   including project targeting, hosted Auth/issuer/origin configuration and failure
   recovery. Mocked hosted CLI tests and local protocol tests are not live proof.
4. If claiming native support, verify physical Capacitor builds, device networking,
   persistence and provider deep-link flows. Chromium does not establish these.
5. Choose operational capacity, anonymous-account abuse and event-retention policies;
   load-test expected leaderboard sizes. Client-authored plausible scores remain
   forgeable; this release is not complete anti-cheat.

See [security](security.md) for reviewed controls and limitations. These gates are
explicit release/operational decisions, not authorization to deploy or publish.

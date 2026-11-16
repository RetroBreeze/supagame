# npm readiness repair

**Goal:** Resolve all six findings in the 16 November publication audit, without publishing or changing hosted projects.

**Scope:** The user's “fix all” authorizes this repair across tooling, packaging and verification. Preserve existing edits; do not commit without authorization. Execute locally without subagents.

**References:** `docs/superpowers/specs/2026-11-08-supabase-game-services-design.md`, `docs/superpowers/plans/2026-11-08-supabase-game-services-v01.md`, and the audit in this conversation.

## Approach

The user selected a full npm migration. Use npm 12.2.0 workspaces and package-lock.json, replacing pnpm scripts, fixtures and CI. Node remains the CLI runtime; Deno is a pinned development tool for the Supabase Edge runtime. npm consumers receive ordinary registry dependencies. Root and examples stay private; the three distribution packages become public-ready. No publishing automation is introduced.

## Repair and verification

- [x] Add a real npm tarball regression for the contracts license and public package metadata; observe failure. Update existing packed-consumer checks to require publishable artifacts.
- [x] Reconcile package-manager configuration and lockfiles, pin compatible ESLint/TypeScript ESLint, restore Deno, and remove the minimatch advisory through a reviewed dependency resolution.
- [x] Make prepack include and verify the canonical license; prepare CLI, SDK and contracts manifests for public publication. Verify npm artifact behavior without publishing.
- [x] Document the authoritative development toolchain and explicit release steps, including contracts-before-SDK ordering.
- [x] Run npm ci, build, unit tests, lint, typechecks, generated-contract checks, Edge tests, real CLI compatibility, tarball installation and dependency audit.
- [x] Run local database, HTTP, SDK and end-to-end suites; stop only fixtures created for this repair. Record any environment blocker accurately.
- [x] Review the final diff and report the results; leave changes uncommitted for review.

## Review focus

- Clean checkouts must install workspace dependencies and the pinned Edge tool.
- Published artifacts must contain the canonical license and resolvable dependency versions.
- Package tests must reject `private: true` in distribution packages.
- Fixes must preserve local deployment confirmation and hosted-operation restrictions.
- Audit the complete workspace dependency tree, rather than only the private root package.

## Verification record

Executed locally on Linux x64, Node 26.10.0, npm 12.2.0, Deno 2.9.6 and
checksum-verified Supabase CLI 3.0.0:

| Command | Result |
| --- | --- |
| `npm ci` | Passed; installs all four workspaces and pinned Deno |
| `npm run build` | Passed for contracts, SDK, CLI and browser example |
| `npm test` | 646 tests passed across 44 files |
| `npm run typecheck` | Root, workspaces and Edge checks passed |
| `npm run lint` | ESLint, Deno lint and formatting passed |
| `npm run contracts:check` | OpenAPI types and SDK validators current |
| `npm run test:edge` | 84 passed |
| `npm run test:packages` | 3 passed, including clean-source npm ci and isolated npm consumers |
| `npm run test:cli:compatibility` | 2 passed with the selected native binary |
| `npm run api:start`, `npm run db:migrate` | Local fixture and migrations ready |
| `npm run test:db` | 809 pgTAP assertions, 2 admin tests, 21 concurrency tests passed |
| `npm run test:cli:db` | 31 passed, also rerun successfully after SDK teardown |
| `npm run test:edge:integration` | 1 test with 13 steps passed |
| `npm run test:sdk:integration` | 13 passed |
| `npm run test:e2e` | 15 passed, including Chromium, saves, Realtime and Admin |
| `npm audit --json` | Zero vulnerabilities across the workspace dependency graph |
| `git diff --check` | Passed |

The npm tarball regression was observed failing on the absent LICENSE before the
prepack fix, then passing. The original tooling failures were reproduced during
the audit. The npm workspace change exposed a frozen Deno lock mismatch; the
Edge runner now uses documented `DENO_NO_PACKAGE_JSON=1`, retaining exactly the
existing deployed dependency graph.

The existing upload-isolation compatibility test requires the native Supabase
binary because it deliberately clears PATH. The npm package's Node launcher
cannot run there; selecting the checksum-verified native binary fixed this test
environment, and the reproduction instructions now include the selector.

No hosted mutations, npm publication, commits, or subagents were used. The
existing local edits were retained or incorporated into the requested migration;
the original manifest and npm lockfile were backed up under the ignored
`.superpowers/npm-readiness-backup/` directory. Test stacks were stopped and the
created regression network removed. CI remains configured for the Node 24/26
× Supabase 3.0.0/3.1.0 matrix; GitHub Actions itself was not run from this session.

### Additional runtime and artifact checks

On Node **24.22.2**, the following also passed: `npm run build`, `npm test`
(646 tests), `npm run typecheck`, `npm run lint`, `npm run contracts:check`,
and `npm run test:packages` (3 tests, including a clean npm ci).

The 2 real CLI compatibility tests passed in all four combinations of
Node **24.22.2 / 26.10.0** and Supabase CLI **3.0.0 / 3.1.0**. The development
Supabase executable was restored to the repository's 3.0.0 pin afterward. The
full database/HTTP/SDK/E2E stack was run on Node 26.10.0 with CLI 3.0.0; those
integration suites were not repeated in the other three combinations.

The documented root-level `npm pack --workspace ... --pack-destination dist/release`
commands produced all three 0.1.0 archives. They are local, ignored build outputs;
no npm publish command was run.

The exact final archives installed successfully in a fresh consumer through the
existing loopback registry fixture (independent CLI, transitive SDK/contracts).
`dist/release/SHA256SUMS` records their SHA-256 digests. Final `npm audit` and
`git diff --check` passed.

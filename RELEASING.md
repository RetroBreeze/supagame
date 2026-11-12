# Preparing npm 0.1.0

**Publication is disabled.** The root and all three packages retain `private: true`.
CI only validates; it has no publishing step, publishing token or OIDC write grant.
Nothing in this guide authorizes publishing, deployment or a GitHub release.

| Directory | Proposed public package | Version |
| --- | --- | --- |
| `packages/contracts` | `@retrobreeze/supagame-contracts` | `0.1.0` |
| `packages/sdk-ts` | `@retrobreeze/supagame-sdk` | `0.1.0` |
| `packages/cli` | `@retrobreeze/supagame-cli` | `0.1.0` |

The executable remains `supagame`. Schema/module versions are independent and
retain their existing history. The npm registry returned HTTP 404 for all three
names on 2026-11-12. This is not a reservation; recheck before publishing.

## Validation without publishing

Use pnpm **12.18.0** and the repository's pinned Supabase CLI **3.0.0** and Deno
**2.9.6**. Docker and Chromium are needed for the complete local verification.
Run all four combinations of Node.js 24/26 and Supabase CLI 3.0.0/3.1.0,
selecting each Node runtime on PATH. Keep the dependency pinned; the Linux x64
test selector verifies the official archive checksum and only replaces the
generated ignored executable in `node_modules/.bin`:

```sh
node --version
pnpm install --frozen-lockfile
# Run once with 3.0.0, then repeat with 3.1.0 on each Node runtime.
node scripts/select-test-supabase.ts 3.0.0
pnpm test:cli:compatibility
pnpm build
pnpm exec playwright install chromium
pnpm test
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm test:edge
pnpm test:packages
# Create once if absent; only the regression fixture uses this network.
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 supagame-schema-tests-local
pnpm api:start
pnpm db:migrate
pnpm test:db
pnpm test:cli:db
pnpm test:edge:integration
pnpm test:sdk:integration
pnpm test:e2e
```

Stop a test stack you started with `pnpm db:stop` when finished. E2E manages its
own separate temporary stack. Do not stop a pre-existing stack owned by another
session. These commands must never be pointed at a hosted project.

`.github/workflows/ci.yml` runs the Node 24/26 × Supabase CLI 3.0.0/3.1.0
matrix for unit/package validation and local integration, on pushes, pull requests and manual dispatch. A successful
local run does not assert that GitHub-hosted jobs have already run.

`test:packages` clones clean source without `dist`, rebuilds at pack time, checks
actual archive contents and exports, installs CLI/SDK by name from a read-only
loopback registry, and resolves contracts transitively. It uses an empty npm user
configuration and a fresh cache. It also checks TypeScript, browser bundling,
runtime imports, the installed CLI, stale-output removal and missing-output
rejection. No public registry write is involved.

## Inspect and use local tarballs

From the repository root, after installing development dependencies:

```sh
mkdir -p dist/release
pnpm --dir packages/contracts pack --pack-destination ../../dist/release
pnpm --dir packages/sdk-ts pack --pack-destination ../../dist/release
pnpm --dir packages/cli pack --pack-destination ../../dist/release
tar -tzf dist/release/retrobreeze-supagame-contracts-0.1.0.tgz
tar -tzf dist/release/retrobreeze-supagame-sdk-0.1.0.tgz
tar -tzf dist/release/retrobreeze-supagame-cli-0.1.0.tgz
```

`pnpm pack` is required to rewrite `workspace:*` into `0.1.0`. Do not use
`npm pack` directly on the workspace SDK. The prepack hook rebuilds dependencies
and validates emitted artifacts; do not bypass lifecycle scripts.

Before public publication, an external project can install all three absolute
tarball paths together (contracts must be supplied because it is not on npm):

```sh
npm install /ABSOLUTE/PATH/retrobreeze-supagame-contracts-0.1.0.tgz /ABSOLUTE/PATH/retrobreeze-supagame-sdk-0.1.0.tgz @supabase/supabase-js@2.119.0
npm install -D /ABSOLUTE/PATH/retrobreeze-supagame-cli-0.1.0.tgz supabase@3.1.0
npx supagame --help
```

Use the [npm quickstart](packages/cli/README.md) for all subsequent commands.

## Manual npm setup and eventual initial publication

An npm organization owner must confirm ownership of **retrobreeze**, grant the
publishing maintainer/team permission to create and publish public scoped packages,
and require maintainer 2FA. Confirm access to `RetroBreeze/supagame` and that its
public repository URL matches each manifest. No npm account settings were changed
by this preparation task.

Only after explicit publication approval, start from the reviewed release commit
and a clean checkout. Re-run validation, then authenticate interactively:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @retrobreeze/supagame-contracts versions --json
npm view @retrobreeze/supagame-sdk versions --json
npm view @retrobreeze/supagame-cli versions --json
```

For these first packages, expect E404 on all three `view` commands. If any name
exists, stop and verify ownership and version availability. Network/authentication
errors are not proof of availability.

The exact safeguard change is to **remove only the `private` property** from
`packages/contracts/package.json`, `packages/sdk-ts/package.json` and
`packages/cli/package.json`. Leave root `package.json` and the demo private.
After authorization, this command makes only those changes:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
for (const name of ['contracts', 'sdk-ts', 'cli']) {
  const path = `packages/${name}/package.json`;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.private !== true || manifest.version !== '0.1.0') throw Error('Review release state');
  delete manifest.private;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
JS
git diff -- packages/contracts/package.json packages/sdk-ts/package.json packages/cli/package.json
```

Review and commit that separately authorized safeguard removal. The preparation
suite deliberately asserts `private: true`; update that release assertion in the
same reviewed publication change before rerunning it. Do not weaken artifact,
security or consumer checks. Pack and inspect all three archives again using the
commands above, then publish **contracts, SDK, CLI**, in that order:

```sh
npm publish ./dist/release/retrobreeze-supagame-contracts-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
npm view @retrobreeze/supagame-contracts@0.1.0 version
npm publish ./dist/release/retrobreeze-supagame-sdk-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
npm view @retrobreeze/supagame-sdk@0.1.0 version
npm publish ./dist/release/retrobreeze-supagame-cli-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
npm view @retrobreeze/supagame-cli@0.1.0 version
```

Complete npm's interactive 2FA prompts. Do not create or store long-lived
publishing tokens. Stop if any publish fails; do not overwrite or reuse a
published version. Local interactive publication does not produce GitHub OIDC
provenance. Do not add `--provenance` to a local command expecting CI attestation.

## Trusted Publishing after the initial packages exist

Enable later, in a separately approved change. Follow npm's current
[Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/):

- Use a reviewed future workflow such as `publish.yml` in this repository, running
  on GitHub-hosted runners. Give only its publication job `id-token: write` and
  `contents: read`; use npm **11.5.1 or later** with OIDC support on Node 24 or 26.
- In each npm package's Trusted Publisher settings, select GitHub Actions:
  owner **RetroBreeze**, repository **supagame**, filename **publish.yml** (no
  directory), and a matching protected GitHub environment such as **npm**.
- Configure environment reviewers and release branch/tag restrictions. Select
  permitted publication actions deliberately. Restrict token publication through
  package settings after OIDC is verified.
- Run the same validation gates, pack with pnpm, publish in dependency order and
  retain provenance. GitHub OIDC publication of public packages from a public
  repository generates provenance automatically.

Do not add a trusted publisher for this validation-only workflow. Configure the
future publisher when its first authorized release is scheduled; npm publisher
setup/expiry rules may change. No automated publisher is enabled by this task.

See [Supabase CLI compatibility](SUPABASE-COMPATIBILITY.md) for the subsequent
3.0.0/3.1.0 verification, command inventory and unverified hosted boundary.

## Initial npm-preparation verification record — 2026-11-12

All commands below exited 0 on **Node 24.22.2** and **Node 26.13.0**, on Linux
with Docker, Supabase CLI 3.0.0, Deno 2.9.6 and pnpm 12.18.0:

| Command | Result on each Node version |
| --- | --- |
| `pnpm build` | All workspace builds passed |
| `pnpm typecheck` | Root, packages, demo and Deno checks passed |
| `pnpm lint` | ESLint, Deno lint and formatting passed |
| `pnpm contracts:check` | OpenAPI DTOs and SDK validators current |
| `pnpm test` | 36 files, 510 tests passed |
| `pnpm test:edge` | 84 tests passed |
| `pnpm api:start`, `pnpm db:migrate` | Local fixture ready; additive migrations current |
| `pnpm test:db` | 809 pgTAP assertions, 2 admin tests, 21 concurrency tests passed |
| `pnpm test:cli:db` | 30 tests passed, including PostgreSQL migration quoting |
| `pnpm test:edge:integration` | 1 test, 13 steps passed |
| `pnpm test:sdk:integration` | 11 tests passed |
| `pnpm test:packages` | 2 tests passed, including clean-source archives and pnpm shim regression |
| `pnpm test:e2e` | 15 tests passed, including Chromium, live updates and Admin Dashboard |

Account-switch identity checks, cross-account saves, offline queue concurrency,
shared IndexedDB, live starvation and request concurrency regressions were retained
and passed in the unit suite. No runtime API or SQL migration was changed.

Node 26 exposed `ENOEXEC` when the package-test harness directly launched pnpm's
shebang-less installer shim. The harness now invokes pnpm through a fixed POSIX
shell command with literal argv forwarding. A new regression reproduces that
failure and checks shell-sensitive arguments. The production CLI was unchanged.

After updating engines, strict-engine isolated installations passed on both
versions. Archive inspection found 115 CLI files, 72 SDK files and 10 contracts
files, with MIT licenses matching the repository, README files, runtime exports
and declarations. No machine-specific paths or development/secrets directories
were present. Intentional CLI template TypeScript/SQL assets remain necessary for
backend provisioning. SDK contracts resolve transitively as exactly `0.1.0`.
The original prepack rebuild and missing-artifact validation remain intact.
The exact CLI README TypeScript example also compiled with strict checking against
the isolated installed archives, including its live subscription callbacks.

Vaccoin source and tests typechecked with the new emitted declarations on both
Node versions using a temporary compiler import mapping outside Vaccoin. Its
working tree was unchanged. Adoption requires updating the old package names and
imports; hosted gameplay, OAuth and deployment were not exercised.

The pre-existing Wiki migration remains uncommitted and must be integrated
separately. Package/example README Wiki-link edits and guide deletions are
preserved in the working tree. The release quickstart is shipped in the CLI
README; no Wiki pages were published by this task. Historical verification
records are not new evidence for this release.

Remaining publication gates: explicit approval and reviewed private-safeguard
removal, npm organization permissions/2FA, availability recheck, and initial
interactive publication. Future OIDC setup is separately authorized. GitHub's
matrix is configured but has not been run by this local session. Node 22,
non-Linux hosts and hosted deployment are not claimed as tested.

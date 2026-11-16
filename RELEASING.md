# Package maintenance

Supagame is distributed through npm:

| Package | Purpose |
| --- | --- |
| `@retrobreeze/supagame-cli` | Backend setup and maintenance; executable `supagame` |
| `@retrobreeze/supagame-sdk` | JavaScript and TypeScript game integration |
| `@retrobreeze/supagame-contracts` | OpenAPI schema and shared types |

For installation, use the [quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart).
For existing projects, follow [Upgrades](https://github.com/RetroBreeze/supagame/wiki/Upgrades).

## Validate package updates

Use npm **12.2.0**, Node.js **24.15 or newer in the 24.x line, or 26.x**,
and Supabase CLI 3.0.0 or 3.1.0. The workspace pins Deno **2.9.6** as an npm
development dependency for Edge tests; the CLI itself runs on Node.js. Docker
and Chromium are required for local integration tests.

`package-lock.json` is the authoritative workspace lockfile. Use `npm ci` for
reproducible installation; workspace dependencies use matching registry versions
so npm links them locally and packed packages resolve normally for consumers.
The workspace array orders builds as contracts, SDK, CLI, then examples.

The root npm override pins affected minimatch versions to 11.0.1 for
GHSA-g3hv-75wg-m249. Remove it when upstream tooling requires a patched release.
Run `npm audit` against the complete workspace tree after dependency updates.

```sh
npm ci
node scripts/select-test-supabase.ts 3.0.0
npm run build
npm run test
npm run typecheck
npm run lint
npm run contracts:check
npm run test:edge
npm run test:packages
node --test tests/e2e/agent-skill.test.ts
npm run test:cli:compatibility
npm audit
```

The selector installs the checksum-verified native Supabase executable for the
Linux x64 compatibility tests, including the test with an intentionally empty
PATH. Repeat with `3.1.0` and `SUPABASE_TEST_VERSION=3.1.0` for the other supported
CLI version. CI performs both versions on Node.js 24 and 26.

Edge scripts use `scripts/edge.ts` to disable automatic package.json resolution
in Deno. The function's pinned imports stay in `deno.lock`, independently of the
Node toolchain in `package-lock.json`; installed function assets are unchanged.

For the full local integration suite, create the fixture network once and run:

```sh
npm exec -- playwright install chromium
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 supagame-schema-tests-local
npm run api:start
npm run db:migrate
npm run test:db
npm run test:cli:db
npm run test:edge:integration
npm run test:sdk:integration
npm run db:stop
npm run test:e2e
```

Stop a fixture you started with `npm run db:stop`. E2E manages its own temporary
stack. These checks use local synthetic users, not hosted project credentials.

`test:packages` builds clean package artifacts, installs them into an isolated
consumer, resolves contracts transitively, and checks exports, declarations,
browser bundling and the installed CLI. `npm pack` runs build and
validation hooks and copies the canonical root license into each package. Keep
these hooks enabled. `test:packages` also verifies that distribution manifests
permit publication and contain registry-resolvable dependencies.

Module/schema versions are independent of npm package versions. Preserve applied
migrations and provide additive upgrades when backend changes are needed.
See the [compatibility record](SUPABASE-COMPATIBILITY.md) for the tested runtime matrix.

## Prepare and publish a release

The repository root and example remain private. The CLI, SDK and contracts
packages are publishable; builds and tests never publish them. After all checks
pass, prepare archives in an empty output directory:

```sh
mkdir -p dist/release
npm pack --workspace @retrobreeze/supagame-contracts --pack-destination dist/release
npm pack --workspace @retrobreeze/supagame-sdk --pack-destination dist/release
npm pack --workspace @retrobreeze/supagame-cli --pack-destination dist/release
```

Inspect the archives and retain them for the release. Publish only after explicit
authorization, using those exact verified archives. Publish contracts first and
wait for registry availability before publishing the SDK, which depends on the
matching contracts version. The CLI can be published independently. Authenticate
with an npm account authorized for the `@retrobreeze` scope; use npm's required
2FA or configured trusted publishing. No registry credentials belong in this repo.

Before later releases, update package versions and the SDK/contracts and example/SDK
dependency versions together, regenerate `package-lock.json`, and rerun the
packed-consumer suite. The current package fixtures are pinned to 0.1.0.

## Cloud Saves protocol gate for the first public release

The approved generation protocol changes the pre-release Cloud Saves contract.
Ship matching migrations, Edge assets, contracts and SDK together. Confirm the
[retention and upgrade guide](docs/guides/cloud-save-protocol.md), existing-data
upgrade tests and retained-JWT regressions before publication. Historical
verification reports do not certify the remediation changes. Review the published
[Cloud Saves](https://github.com/RetroBreeze/supagame/wiki/Cloud-Saves),
[Upgrades](https://github.com/RetroBreeze/supagame/wiki/Upgrades) and
[agent skill](.agents/skills/supagame/SKILL.md) against the same candidate. Keep
current guides synchronized; archived examples are not installation instructions.
Wiki publication, npm publication and hosted deployment are separate operations
and each needs authorization for its own destination.

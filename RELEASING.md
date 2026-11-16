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

Use the pinned pnpm and Deno versions, Node.js 24 or 26, and Supabase CLI 3.0.0
or 3.1.0. Docker and Chromium are required for local integration tests.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm test:edge
pnpm test:packages
pnpm test:cli:compatibility
```

For the full local integration suite, create the fixture network once and run:

```sh
pnpm exec playwright install chromium
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 supagame-schema-tests-local
pnpm api:start
pnpm db:migrate
pnpm test:db
pnpm test:cli:db
pnpm test:edge:integration
pnpm test:sdk:integration
pnpm test:e2e
```

Stop a fixture you started with `pnpm db:stop`. E2E manages its own temporary
stack. These checks use local synthetic users, not hosted project credentials.

`test:packages` builds clean package artifacts, installs them into an isolated
consumer, resolves contracts transitively, and checks exports, declarations,
browser bundling and the installed CLI. `pnpm pack` resolves workspace dependency
versions; keep its build and validation hooks enabled.

Module/schema versions are independent of npm package versions. Preserve applied
migrations and provide additive upgrades when backend changes are needed.
See the [compatibility record](SUPABASE-COMPATIBILITY.md) for the tested runtime matrix.

## Cloud Saves protocol gate for the first public release

The approved generation protocol changes the pre-release Cloud Saves contract.
Ship matching migrations, Edge assets, contracts and SDK together. Confirm the
[retention and upgrade guide](docs/guides/cloud-save-protocol.md), existing-data
upgrade tests and retained-JWT regressions before publication. Historical
verification reports do not certify the remediation changes. The local Wiki
update draft requires separate authorization before pushing.

# Supabase Game Services

## Proposed npm release

The initial packages are `@retrobreeze/supagame-cli`, `@retrobreeze/supagame-sdk`
and `@retrobreeze/supagame-contracts`, all version **0.1.0**. They remain private
until publication is explicitly authorized. Use **Node.js 24 or 26**. After publication:

```sh
npm install -D @retrobreeze/supagame-cli supabase@3.1.0
npm install @retrobreeze/supagame-sdk @supabase/supabase-js@2.119.0
npx supagame init --project-ref YOUR_PROJECT_REF --origin http://localhost:5173
```

Follow the [npm quickstart](packages/cli/README.md) for board creation, deployment,
SDK initialization, score submission, reads and live subscriptions. The CLI
supports Supabase CLI **3.0.0 and 3.1.0** (`3.0.0 || 3.1.0`).
See [CLI compatibility and verification limits](SUPABASE-COMPATIBILITY.md) and
[release preparation](RELEASING.md) for local tarballs, verification and the
separately authorized publication steps.

An MIT-licensed toolkit for installing modular gaming services into your own
Supabase project. Games use a versioned HTTP API or a thin TypeScript SDK; the CLI
provisions and maintains the backend. There is no central service operated by this
project.

**[Documentation Wiki](https://github.com/RetroBreeze/supagame/wiki)** ·
**[Quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart)** ·
**[API reference](https://github.com/RetroBreeze/supagame/wiki/API)**

## Services

- Anonymous player identities, display names and best-score leaderboards.
- Optional [Live Leaderboards](https://github.com/RetroBreeze/supagame/wiki/Live-Leaderboards)
  and [Achievements](https://github.com/RetroBreeze/supagame/wiki/Achievements).
- [Cloud Saves](https://github.com/RetroBreeze/supagame/wiki/Cloud-Saves),
  [account linking and recovery](https://github.com/RetroBreeze/supagame/wiki/Accounts).
- Optional [CLI administration](https://github.com/RetroBreeze/supagame/wiki/Admin)
  and a [local Admin Dashboard](https://github.com/RetroBreeze/supagame/wiki/Admin-Dashboard).

## Get started

Follow the [quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart)
for local tarball installation, CLI login, feature selection and deployment.
Packages are private until publication is separately approved.

Deployment previews the destination and changes and requires explicit confirmation.
Each installation belongs to your Supabase project. Games use only a publishable
key and their own session; see the
[security model and limitations](https://github.com/RetroBreeze/supagame/wiki/Security).

- [Installation reference](https://github.com/RetroBreeze/supagame/wiki/Installation-Reference)
- [Local development](https://github.com/RetroBreeze/supagame/wiki/Local-Development)
- [TypeScript SDK](packages/sdk-ts/README.md) and [browser demo](examples/browser-demo/README.md)
- [Troubleshooting](https://github.com/RetroBreeze/supagame/wiki/Troubleshooting)
- [Diagnostics and upgrades](https://github.com/RetroBreeze/supagame/wiki/Upgrades)

## Contributing

Development setup, database and HTTP internals, CLI behavior and verification
commands are in the
[implementation reference](https://github.com/RetroBreeze/supagame/wiki/Implementation-reference).
See the [verification records](https://github.com/RetroBreeze/supagame/wiki/Verification)
for recorded results and remaining release gates.

Public documentation is maintained in the Wiki. The [documentation index](docs/README.md)
maps the former guide paths to their Wiki pages. Design and implementation plans
remain in [docs/superpowers](docs/superpowers/); package and example READMEs stay
with their source. The [OpenAPI contract](packages/contracts/openapi.yaml) is the
source of truth for the public HTTP interface.

## Licence

[MIT](LICENSE), copyright 2026 Supabase Game Services contributors.

Hosted `supagame deploy` does not require Docker: Edge Functions use Supabase's
API bundling (`--use-api`) from the existing isolated staging directory.
Local Supabase development and database/integration tests ordinarily require
Docker or another supported container runtime. Deployment authorization,
explicit project selection, previews, journals and recovery are unchanged.
API bundling cannot deploy `static_files`; current Supagame templates need no
static assets, and configured static files are rejected before deployment.
See [Supabase's asset limitation](https://supabase.com/docs/guides/functions/wasm).

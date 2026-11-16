# CLI setup, modules and deployment

## Prerequisites and destination

Use Node.js 24 or 26 and supported Supabase CLI 3.0.0 or 3.1.0; check
`node --version`, `supabase --version` and `supagame --help` in the actual tooling
environment. Hosted setup does not need Docker; local integration needs Docker
and the relevant Supabase services. Public package names are
`@retrobreeze/supagame-cli`, `@retrobreeze/supagame-sdk` and
`@retrobreeze/supagame-contracts`. Do not use historical `@supagame/*` names.

For an npm consumer, the documented tool installation is:

```sh
npm install -D @retrobreeze/supagame-cli supabase@3.1.0
```

Use the project's package manager. In a native repository, install CLI tooling
in a separate tooling directory if preferred, and pass `--workdir <game-root>`
to Supagame commands. Do not create a JS runtime or change the engine build.
Examples below assume the tools resolve in PATH through `npx` and the current
directory is the intended project root. Supagame does not search parent folders.
Replace `YOUR_PROJECT_REF` with the verified 20-character reference.

For source-checkout development only, the Supagame workspace uses npm 12.2.0,
`package-lock.json`, and `npm ci`, with Node 24.15+ (24.x) or 26.x. Deno is an npm
development dependency for Edge checks, not the CLI runtime. Consumer games keep
their own package manager and engine conventions.

`npx supabase login` establishes operator access; `npx supabase projects list`
can identify accessible projects. Keep management credentials in the operator
environment, never game configuration. `init` records a reference locally; this
alone does not verify hosted access or create a hosted Supabase project.
Manifest, explicit reference and any existing Supabase link metadata must agree.
Do not relink or overwrite records to silence a mismatch.

## Local configuration

In a real terminal, fresh `npx supagame init` offers project/service selection
and optional login, origins and connection export. With an existing manifest or
explicit project ref, use `--interactive` if guided setup is wanted. Leaderboard
and achievement creation prompt for missing options in a TTY. `add`,
`saves configure`, `upgrade` and `config origins add` do not offer setup wizards.
CI, redirected streams, `--json` and `--no-interactive` disable prompts;
`--interactive` does not create a TTY. Explicit noninteractive setup:

<!-- local-check -->
```sh
npx supagame init --project-ref YOUR_PROJECT_REF --module leaderboards --origin http://localhost:5173 --no-interactive --dry-run
npx supagame init --project-ref YOUR_PROJECT_REF --module leaderboards --origin http://localhost:5173 --no-interactive
npx supagame leaderboard create arcade --type points --order desc --keep-best --min 0 --no-interactive
```

Choose the actual browser origin, not necessarily port 5173; omit `--origin` for
native builds without a browser. `init` without `--module` in noninteractive mode
only initializes configuration. On an initialized installation,
`npx supagame add leaderboards` stages the module. Module staging includes Core
and Leaderboards prerequisites; it preserves existing modules. Every local
staging command supports `--dry-run`. Review `supagame.config.json`, additive
`supabase/migrations/`, staged `supabase/functions/supagame/` and configuration
changes. Never rewrite applied migrations or manually forge module versions.

Leaderboards accept `--type points|time`, `--order asc|desc`, required
`--keep-best`, optional safe-integer `--min`/`--max`. Choose units explicitly
(e.g. milliseconds with `time`, `asc`). Definitions are immutable through create;
reuse the same definition or plan a new board rather than reinterpret scores.

Only enable the following when requested:

<!-- local-check -->
```sh
npx supagame add achievements
npx supagame achievement create first-1000 --title "First 1000" --description "Score 1000 in one submission" --board arcade --threshold 1000 --no-interactive
npx supagame add cloud-saves
npx supagame saves configure --max-slots 10 --max-json-bytes 1048576 --max-binary-bytes 52428800 --max-total-bytes 104857600
npx supagame add live-leaderboards
```

- Achievements unlock permanently from one accepted score meeting a nonnegative
  threshold on a **descending** board. No arbitrary client unlock, cumulative
  counter or ascending-time rule. Definitions are immutable; reads do not unlock.
- Cloud Saves adds private JSON/binary storage and quota configuration. Defaults
  above are 10 slots, 1 MiB JSON, 50 MiB binary and 100 MiB total per player.
  Storage service limits may be lower. Reducing quotas never deletes saves.
- Live Leaderboards needs Supabase Realtime Database Broadcast, private-channel
  RLS and authenticated receive grants. Start the full local stack when testing.
  Do not alter Supabase-owned tables or global channels to force it to work.
- Admin is optional trusted operator tooling, including a local dashboard; it is
  not a hosted game dashboard or a player-client API.

Read public connection details with `npx supagame connection`, optionally
`--output supagame.connection.json`. This requires operator access to project
keys; use `--key-id <id>` if multiple public keys exist. `--replace` only updates
recognized same-project exports. Fields are `schemaVersion`, `projectRef`,
`supabaseUrl`, `publishableKey`, `apiBaseUrl`. Use the game's existing config
format, not mandatory Vite variables or `.env.local`.

## Hosted preview and authorization

```sh
npx supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
```

This reads hosted state and needs operator access. Show the user its destination,
modules, all pending SQL (including unrelated project migrations), function
change, anonymous Auth change and origin changes. SQL can have arbitrary effects;
review its contents. If unrelated pending migrations are outside authorization,
stop for scope resolution; never hide/delete them to change the preview.

Only after explicit approval of that destination and plan:

```sh
npx supagame deploy --project-ref YOUR_PROJECT_REF
```

A TTY asks for `deploy YOUR_PROJECT_REF`. An authorized noninteractive run uses
`--allow-remote` with the explicit reference. `--json`, environment variables and
CI status are not consent. Never combine `--dry-run` with `--allow-remote`.
If state changes, obtain approval for the new preview. The adapter checks supported
CLI capabilities and explicitly targets hosted operations; do not substitute bare
Supabase v3 `db push` (local by default).

Deploy selects only the `supagame` function and narrowly manages anonymous Auth
and `SG_ALLOWED_ORIGINS`. It excludes unrelated config/secrets, seeds, roles and
Vault synchronization. Do not substitute a broad `config push`. Existing Auth
providers/redirects belong to a separate reviewed workflow (`auth ... --help`).

Retain `supabase/.temp/supagame-deploy.json`, the origin receipt and any deployment
lock after an interruption. A `database_started` journal with unapplied attempted
migrations requires inspection for partial effects; do not discard the journal
or rename/edit migrations. For `function_started`, inspect `doctor --remote` and
another deployment dry-run, then authorize only the remaining work. Do not retry
uncertain writes automatically. Raw `--diagnostic-log <file>` is opt-in and may
contain secrets even though its newly created file is private.

## Upgrades

Review installed package/module versions and the release's migration notes, then
use a matching CLI and preview forward-only staging:

<!-- local-check -->
```sh
npx supagame upgrade --dry-run
```

`npx supagame upgrade` applies the reviewed **local** plan. It does not deploy or
install npm updates. Preserve old migration bytes, resolve drift and coordinate
matching Edge/SDK assets. Old Cloud Saves writers/queues without generation
cannot be silently upgraded into new writes. Repeat hosted preview/consent and
runtime checks separately.

Canonical guides: [CLI](https://github.com/RetroBreeze/supagame/wiki/CLI),
[Upgrades](https://github.com/RetroBreeze/supagame/wiki/Upgrades).

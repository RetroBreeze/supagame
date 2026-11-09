# Diagnostics and forward-only upgrades

`supagame.config.json` is version-controlled installation intent:
`formatVersion: 1`, selected `projectRef`, installed `modules` and declarative
`leaderboards`. The current authoritative inventory contains only **core 0.1.0**
and **leaderboards 0.1.0**. No newer production release or fabricated migration
exists to demonstrate an upgrade.

## Inspect before changing anything

```sh
npx --no-install supagame doctor
npx --no-install supagame doctor --local
# Optional read-only hosted inspection; exact selected reference required:
npx --no-install supagame doctor --remote --project-ref YOUR_REAL_PROJECT_REF
```

Plain doctor works without hosted credentials. It checks local configuration,
manifest/module compatibility, expected migration bytes, leaderboard definitions,
function files and configuration, and the local anonymous-auth setting. `--local`
adds migration-ledger/catalog checks against the running local stack. Remote mode
requires an explicit ref matching the manifest and link metadata; it never infers
a target. Local and remote modes cannot be combined.

Statuses are **healthy**, **warning**, **error** and **cannot verify**. Missing
remote credentials, unsupported CLI responses, unavailable inspection or evidence
of drift are reported, not treated as success. Doctor never changes local files,
Auth settings, functions, migrations or database records. A schema version inferred
from the migration ledger is not a checksum of deployed SQL bodies. Remote Auth
and function verification can remain unavailable; read each diagnostic's scope.

## Stage known upgrades

```sh
npx --no-install supagame upgrade --dry-run
npx --no-install supagame upgrade
```

For an intact 0.1.0 installation these report **up to date; no upgrade available**.
The dry run and a repeated real run produce no changes. Upgrade is local staging,
never deployment. Future paths must exist in the version inventory and use known
additive migrations/versioned assets. Unsupported/newer installed versions,
incompatible core/leaderboards pairs, missing historical migrations and modified
assets cause actionable errors. Fixture tests cover future-version behavior.

Safeguards include byte checks on historical migrations, migration-version
collision checks, path/symlink validation, no overwrite of user changes, staging
rollback on write failure and writing the manifest last. Existing applied SQL is
never rewritten; no reset, downgrade or automatic deletion is available.

For a future compatible release:

1. Commit/back up the installation and review that release's compatibility notes.
2. Install the explicitly chosen CLI version; run doctor and upgrade dry-run.
3. Resolve conflicts by understanding local edits, not forcing an overwrite.
4. Stage, inspect and commit additive changes; test on a local/staging project.
5. Deploy separately with an explicit matching target and fresh confirmation.

Rollback of schema/data is not automatic. Use forward fixes or an independently
planned recovery from backups. Changing an existing board's definition is rejected
by `leaderboard create`; semantic changes need a separately reviewed additive
migration. Do not edit its old migration or manifest alone to disguise drift.

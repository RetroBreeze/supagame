# Admin verification — 11 November 2026

All operations used local synthetic fixtures. No hosted SQL, deploy, push or
publication was performed. Vaccoin was inspected read-only and was not modified.

## Results

Node 24.22.2:

| Command | Result |
| --- | --- |
| `pnpm test` | 434 tests passed, 29 files |
| `pnpm test:db` | 809 baseline pgTAP assertions; optional Admin lifecycle runner; 21 concurrency tests passed |
| `node --test tests/db/admin.test.ts` | 38 Admin pgTAP assertions passed, migration rolled back |
| `pnpm test:cli:db` | 28 tests passed |
| `pnpm test:edge` | 84 tests passed |
| `pnpm test:edge:integration` | 1 integration test, all 13 steps passed |
| `pnpm test:sdk:integration` | 11 tests passed |
| `pnpm test:e2e` | 13 tests passed, including fresh packaged Admin, live reset refresh, restrictions and concurrent resets/submission |
| `pnpm test:packages` | Fresh CLI, contracts and SDK tarballs built and installed in an isolated consumer; Admin staging and upgrade preview passed |
| `pnpm typecheck`, `pnpm lint`, `pnpm contracts:check`, `pnpm build` | Passed |

Node 26.13.0 compatibility: the 430-test suite before the last four additional
CLI failure-path tests passed. Node 24 remains the supported package engine.

The existing database suite runs without Admin. The Admin test applies the
optional migration inside a transaction and rolls it back, preserving baseline
expectations for disabled-board reads and four-field cursors. The isolated E2E
installs Admin after a populated baseline and exercises its packaged CLI against
real local Auth, SQL, Edge and Realtime services. Concurrent resets with the same
expected revision produce one winner; concurrent submissions belong wholly to
the old or new generation.

During verification a local reset moved the database to the default Docker
network; the dedicated fixture network was reattached. Restarting its stale Edge
runtime resolved HTTP 503s. SDK integration left a retired binary object; the
existing local Cloud Saves cleanup command removed it before the final doctor
regression. All affected checks were rerun successfully. An initial package run
used stale dist output; rebuilding before packing resolved it and the fresh
package/E2E checks passed.

## Review and limitations

Reviewed inline under the repository's no-subagents instruction: safe search
paths, grants/RLS, lock ordering, original receipt replay, generation filtering,
moderation projection, operation uniqueness and immutable migration inventory.
No independent security audit was performed.

- Audit actors identify the database operator role, not an independently verified
  human Supabase account. Failed/rolled-back requests have no committed audit row.
- Operator access retains database-owner recovery powers. Delegated permissions
  are infrastructure only; no delegated HTTP endpoint or dashboard is installed.
- Audit output is bounded to the latest 100 operations; historical generation
  inspection shows up to 100 recent accepted events and counts all generations.
- Generation reset has no automatic rollback command. Historical events remain
  stored. Anonymous restrictions do not prevent creating a new identity.
- Live/schema upgrade migrations are local files until separately deployed.

## Vaccoin preview

Use Node 24 and Supabase CLI 3.0.0. These commands do not deploy:

```sh
cd ~/Projects/supagame
pnpm build
node packages/cli/dist/cli.js upgrade --workdir ~/Projects/vaccoin --dry-run
```

For a complete Admin deployment preview without editing the working integration,
copy its current files to an isolated directory first (include its existing
uncommitted files; do not copy secrets into a shared location). In that private
copy, run:

```sh
VACCOIN_PREVIEW_ROOT=$(mktemp -d)
mkdir "$VACCOIN_PREVIEW_ROOT/project"
cp -a "$HOME/Projects/vaccoin/." "$VACCOIN_PREVIEW_ROOT/project/"
VACCOIN_PREVIEW="$VACCOIN_PREVIEW_ROOT/project"
supagame upgrade --workdir "$VACCOIN_PREVIEW"
supagame add admin --workdir "$VACCOIN_PREVIEW" --dry-run
supagame add admin --workdir "$VACCOIN_PREVIEW"
supagame deploy --workdir "$VACCOIN_PREVIEW" --dry-run \
  --project-ref ttwppnsnxcighfcesxhf
```

Use the freshly built CLI path in place of `supagame` if it is not installed.
Deployment preview requires the operator's existing Supabase authentication and
network access. No custom Admin secret, manual public grant or in-game change is
needed. Real hosted deployment requires separate explicit authorization.

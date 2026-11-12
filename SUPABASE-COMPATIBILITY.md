# Supabase CLI compatibility

Supagame accepts the stable versions **3.0.0 and 3.1.0**, expressed as
`3.0.0 || 3.1.0`. This deliberately excludes untested patches/minors, other
major versions, prereleases, build metadata and malformed version output.
Consumers can install `supabase@3.1.0`; the repository development dependency
and lockfile stay pinned to **3.0.0** for reproducibility.

## Upstream investigation

Reviewed the [3.1.0 release](https://github.com/supabase/cli/releases/tag/v3.1.0)
and [tagged 3.0.0 → 3.1.0 source changes](https://github.com/supabase/cli/compare/v3.0.0...v3.1.0),
including command handlers, formatters, target resolution, hosted consent,
configuration loading and database connection code. The consumed command flags
and JSON fields remain compatible in those sources. Relevant changes are:

- **Configuration precedence:** 3.1.0 adds `config.jsonc`; selection is JSON,
  then JSONC, then TOML. Supagame manages TOML. Initialization preserves and
  rejects JSON/JSONC-only projects pending manual conversion. Admin refuses
  ambiguous formats, doctor warns, and deployment/inspection workspaces exclude
  JSON, JSONC, dotenv and remote overlays. Existing dual-format deployment
  isolation is preserved.
- **Linked-database TLS:** 3.1.0 verifies linked database CA certificates for
  database/migration commands. Supagame does not disable verification or add a
  fallback to insecure connections. Actual hosted certificate retrieval and
  connection behavior require an authorized hosted smoke test.
- **Function CORS:** 3.1.0 removes implicit gateway wildcard CORS. Supagame's
  function already implements its own allowed-origin and preflight handling;
  local HTTP/browser tests exercise that implementation.
- **API retries and secrets:** 3.1.0 adds retry controls and function environment
  handling. Supagame's child environment whitelist continues to strip ambient
  overrides. Scoped secret installation still uses an isolated workspace and
  explicit env file, with no application config secrets loaded.

## Invoked commands and retained contracts

Every hosted invocation specifies `--remote=<project-ref>` and `--workdir`.
Envelope commands use `--output-format json`; database row queries intentionally
use `--agent=no --output json`. Raw subprocess errors are not printed.

| Invocation | Parsed result / safety condition |
| --- | --- |
| `--version` | Trimmed stdout must equal one of the two supported stable versions; update notices on stderr are ignored. |
| `migration list` | `target.kind=linked`, exact `target.project_ref`, complete `migrations[]` inventory with validated local/remote versions. Local diagnostics require loopback host and exact port. |
| `db push --dry-run --include-all --skip-vault` | Verified target, `dryRun=true`, exact ordered migration filenames, empty `roles` and `seeds`. No mutation consent is passed. |
| `db push --include-all --skip-vault --yes` | Runs only after the verified preview and explicit Supagame confirmation/`--allow-remote`; response target checked and installation inspected afterward. |
| `functions list` | Verified target and `functions[]`; unique `supagame` slug, positive integer version, status, optional JWT flag and SHA256 validated. |
| `functions deploy supagame --yes` | Same consent boundary; response target, `project_ref` and single `functions=['supagame']` checked, followed by remote inspection. |
| `config diff` | Verified target, `schema_version=1`, scope/changes/masked/unmanaged arrays. Only the declared anonymous-auth change is permitted; unrelated config changes fail closed. |
| `config push --yes` | Pushes only the deliberately minimal Auth configuration after explicit consent, then re-inspects. |
| `secrets list` | Verified target and validated secret names/digests; never reads secret plaintext. |
| `secrets set --env-file <temporary-file> --yes` | Installs the reviewed origin setting only after consent, then re-inspects. |
| `db query <sql> --read-only --agent=no --output json` | Validated row arrays for catalog, Auth/Realtime and installation inspection; caller-selected isolated target. |
| `db query <sql> --agent=no --output json --yes` | Existing explicit admin/cleanup authorization and target safeguards remain in place; operation-specific results validated. |

Database row JSON has no target envelope. Target selection is therefore enforced
through the isolated workspace and literal command arguments, with result-schema
checks; it is not misrepresented as a returned target assertion.

Deployment now checks `--help` for all nine command families before hosted reads
or writes, requiring the target/output/workdir flags and each operation's dry-run,
consent and file flags. Missing/renamed flags or failed help commands stop before
mutations. Version/help checks supplement, rather than replace, JSON validation.
Children receive closed stdin and `SUPABASE_YES=false`; only already-authorized
mutation paths carry `--yes`. The admin permission probe is a fixed catalog SELECT
using the operator transport and retains its existing explicit CLI consent. Failure after a real mutation cannot undo it; existing
partial-deployment recovery and post-write checks are preserved.

Cloud-save local cleanup also invokes `status --output json`, validates the
loopback `API_URL` and consumes `SERVICE_ROLE_KEY` only inside the operator
process. That transport is unchanged in the reviewed versions. The command
review found that hosted cleanup obtained Supagame consent but omitted the CLI
`--yes` flag: both upstream versions reject such write queries with closed stdin.
Cleanup now forwards `--yes` only after explicit confirmation/`--allow-remote`;
regressions preserve dry-run, declined and unattended refusal. No actual hosted
cleanup or Storage deletion was performed.

Local test infrastructure additionally invokes `start`, `stop`, `status`,
`migration up`, `test db` and Docker against disposable synthetic fixtures.

## Reproduce the matrix

On Linux x64, install the pinned workspace dependencies, select Node 24 or 26,
and run the complete commands in [RELEASING.md](RELEASING.md). Repeat with each
Supabase version:

```sh
pnpm install --frozen-lockfile
node scripts/select-test-supabase.ts 3.0.0
SUPABASE_TEST_VERSION=3.0.0 pnpm test:cli:compatibility
# Repeat the full release-validation suite, then select 3.1.0 and repeat it.
node scripts/select-test-supabase.ts 3.1.0
SUPABASE_TEST_VERSION=3.1.0 pnpm test:cli:compatibility
```

The selector downloads official Linux AMD64 archives and verifies these SHA256
values before replacing only the generated `node_modules/.bin/supabase` link:

| Version | Official release archive SHA256 |
| --- | --- |
| 3.0.0 | `eeb61edcd59a4735fcb5e58596574f25d03d420efca779f43ddb307e1cc5c754` |
| 3.1.0 | `dbe9fd66771337fc198727da86b9d3551302f87a7091cd8781be2a4cd0c8ac4d` |

CI selects these binaries after frozen installation in both the unit/package and
local integration jobs, across Node `[24, 26]` × Supabase `[3.0.0, 3.1.0]`.
No publication, hosted deployment, publishing credentials or OIDC write grant is
introduced. The test selector is not a production binary-override mechanism.

## Verification boundary

`test:cli:compatibility` runs the real executable for version/help, explicit
remote selection despite a conflicting link, function/secret JSON serialization,
scoped Auth diff parsing and closed-stdin function deployment/write-query refusal. It uses a loopback
Management API fixture with a synthetic token, an empty home/config directory,
and a server that rejects writes. All recorded API requests must be GETs.
These responses are simulated; they do **not** prove hosted API compatibility.

`test:cli:db` exercises actual local migration inventory, push dry-run (including
proof that the preview does not apply its pending migration), catalog queries
and read-only doctor. Existing local integrations/E2E exercise migrations,
Edge Functions, SDK/browser behavior and packaged installation. Unit regressions
cover unsupported/malformed versions, unexpected JSON, target mismatches,
missing/changed flags, failed commands, timeouts and aborts; malformed preflight
responses must produce zero mutation calls even with `--allow-remote`.

No hosted login/OAuth, database certificate exchange, hosted migration push,
function bundling/upload, config push or secret write was executed. Those remain
an explicitly unverified boundary requiring a separately authorized disposable
hosted project. Non-Linux operating systems were not tested. No API/SQL changes,
npm publication, private-flag removal, Vaccoin modification or Target Rush work
are included.

## Verification record — 2026-11-12

The final implementation passed the complete local suite on Linux x64 using
pnpm 12.18.0, Deno 2.9.6, Docker and Chromium, with official checksum-verified
Supabase binaries:

| Node.js runtime | Supabase CLI | Complete suite |
| --- | --- | --- |
| 24.22.2 | 3.0.0 | Passed |
| 24.22.2 | 3.1.0 | Passed |
| 26.13.0 | 3.0.0 | Passed |
| 26.13.0 | 3.1.0 | Passed |

Every command below exited 0 in **each** of those four combinations:

| Command | Result per combination |
| --- | --- |
| `pnpm build` | All workspace builds passed |
| `pnpm typecheck` | Root, packages, browser example and Deno checks passed |
| `pnpm lint` | ESLint, Deno lint and formatting passed |
| `pnpm contracts:check` | DTOs and SDK validators current |
| `pnpm test` | 36 files, 575 unit tests passed |
| `pnpm test:cli:compatibility` | Real binary version, nine command help surfaces, loopback JSON/target/consent test passed |
| `pnpm test:edge` | 84 tests passed |
| `pnpm api:start`, `pnpm db:migrate` | Local fixture ready and migrations current |
| `pnpm test:db` | 809 pgTAP assertions, 2 admin tests, 21 concurrency tests passed |
| `pnpm test:cli:db` | 30 tests passed, including actual migration preview and doctor |
| `pnpm test:edge:integration` | 1 test with 13 steps passed |
| `pnpm test:sdk:integration` | 11 tests passed |
| `pnpm test:packages` | 2 tests passed: clean-source packing, isolated consumer and artifact safeguards |
| `pnpm test:e2e` | 15 tests passed, including Chromium, private live broadcasts, saves and admin |

The existing account identity/isolation, offline concurrency, IndexedDB, live
starvation/concurrency, PostgreSQL quoting and package artifact regressions were
retained. New version/capability, JSONC and cleanup-consent regressions were
observed failing before their fixes, then passing. Timeout/abort and malformed
preflight coverage also passed. No hosted mutation was used to obtain these
results; the simulated API boundary described above still applies.

GitHub Actions is configured for the same four combinations; these results are
local executions, not a claim that GitHub-hosted jobs have already run. All
package `private: true` safeguards and the root Supabase 3.0.0 development pin
remain in place. The existing Wiki migration was preserved outside this commit.

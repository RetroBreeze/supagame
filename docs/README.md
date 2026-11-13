# Documentation

Public documentation has moved to the [GitHub Wiki](https://github.com/RetroBreeze/supagame/wiki).
Start with the [quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart).
Edit public guides and verification records in the Wiki; update its Home page and
sidebar when adding or renaming pages.

`docs/superpowers/` retains design documents and implementation plans required by
`AGENTS.md`. Paths mentioned in those historical plans describe the layout at the
time; use the mapping below to find migrated guides and verification records.
Package and example READMEs, the changelog and the OpenAPI contract remain in the
source repository. The repository README is now a short entry point; its complete
previous content is preserved in the Wiki's implementation reference.

## Moved pages

| Former path | Wiki page |
| --- | --- |
| `docs/account-recovery-verification.md` | [Account Recovery Verification](https://github.com/RetroBreeze/supagame/wiki/Account-Recovery-Verification) |
| `docs/account-verification.md` | [Account Verification](https://github.com/RetroBreeze/supagame/wiki/Account-Verification) |
| `docs/accounts.md` | [Accounts](https://github.com/RetroBreeze/supagame/wiki/Accounts) |
| `docs/achievements-verification.md` | [Achievements Verification](https://github.com/RetroBreeze/supagame/wiki/Achievements-Verification) |
| `docs/achievements.md` | [Achievements](https://github.com/RetroBreeze/supagame/wiki/Achievements) |
| `docs/admin-dashboard-verification.md` | [Admin Dashboard Verification](https://github.com/RetroBreeze/supagame/wiki/Admin-Dashboard-Verification) |
| `docs/admin-dashboard.md` | [Admin Dashboard](https://github.com/RetroBreeze/supagame/wiki/Admin-Dashboard) |
| `docs/admin-verification.md` | [Admin Verification](https://github.com/RetroBreeze/supagame/wiki/Admin-Verification) |
| `docs/admin.md` | [Admin](https://github.com/RetroBreeze/supagame/wiki/Admin) |
| `docs/api.md` | [API](https://github.com/RetroBreeze/supagame/wiki/API) |
| `docs/cloud-saves-verification.md` | [Cloud Saves Verification](https://github.com/RetroBreeze/supagame/wiki/Cloud-Saves-Verification) |
| `docs/cloud-saves.md` | [Cloud Saves](https://github.com/RetroBreeze/supagame/wiki/Cloud-Saves) |
| `docs/installation-reference.md` | [Installation Reference](https://github.com/RetroBreeze/supagame/wiki/Installation-Reference) |
| `docs/installation-validation.md` | [Installation Validation](https://github.com/RetroBreeze/supagame/wiki/Installation-Validation) |
| `docs/live-leaderboards-verification.md` | [Live Leaderboards Verification](https://github.com/RetroBreeze/supagame/wiki/Live-Leaderboards-Verification) |
| `docs/live-leaderboards.md` | [Live Leaderboards](https://github.com/RetroBreeze/supagame/wiki/Live-Leaderboards) |
| `docs/local-development.md` | [Local Development](https://github.com/RetroBreeze/supagame/wiki/Local-Development) |
| `docs/quickstart.md` | [Quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart) |
| `docs/security.md` | [Security](https://github.com/RetroBreeze/supagame/wiki/Security) |
| `docs/troubleshooting.md` | [Troubleshooting](https://github.com/RetroBreeze/supagame/wiki/Troubleshooting) |
| `docs/upgrades.md` | [Upgrades](https://github.com/RetroBreeze/supagame/wiki/Upgrades) |
| `docs/verification.md` | [Verification](https://github.com/RetroBreeze/supagame/wiki/Verification) |
| `README.md` | [Implementation reference](https://github.com/RetroBreeze/supagame/wiki/Implementation-reference) |

## Hosted function deployment diagnostics (13 November 2026)

The reported Arch Linux / Node 26.9.0 / Supabase CLI 3.1.0 failure has no
established root cause. Successful direct deployment and browser testing prove
that the deployed service works, but do not recover the discarded error from
Supagame's earlier attempt. No deployment behavior was changed speculatively.

The traced path is `deploy.ts` → `isolatedProject` → `SupabaseCli.deployFunction`
→ `createSupabaseRunner` → JSON/target/response validation → `functionInfo`.
Before the function step, configuration and migrations are verified, and the
journal is written as `function_started`. The subprocess uses literal arguments:

```text
supabase functions deploy supagame --yes --remote=<explicit-ref> --workdir <isolated-directory> --output-format json
```

`--yes` is passed only after Supagame's existing authorization and state recheck.
The isolated directory contains validated function assets, migrations and minimal
configuration (`verify_jwt=false`, explicit entrypoint/import map, seeds disabled).
It excludes project dotenv files, unrelated functions and configuration overrides.
It is removed in `finally`; the original project's journal remains.

The subprocess has closed stdin, a five-minute timeout and an 8 MiB output limit.
Only PATH, HOME, USERPROFILE, SystemRoot, TEMP/TMP/TMPDIR, XDG_CONFIG_HOME,
DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, SUPABASE_ACCESS_TOKEN and
SUPABASE_DB_PASSWORD are forwarded. SUPABASE_YES is explicitly false. Shell
proxy, custom CA, Docker and Node overrides are not forwarded. A direct command
can use the original workdir/configuration, ambient environment, text output,
interactive stdin and no wrapper timeout. These are investigation candidates,
not demonstrated causes; the allowlist and deployment arguments are unchanged.

Diagnostics now identify subprocess execution, JSON parsing, target validation,
deployment response validation, or post-deployment inspection. A successful
response must identify the selected target and exactly `supagame`. Inspection
must find an ACTIVE function with `verify_jwt=false`; version and optional hash
must satisfy the existing schema. Exit codes are reported; interrupted processes
without a numeric exit report `unknown` and remain uncertain.

For credential safety, stdout/stderr summaries extract only fixed, recognized
error codes (connection, DNS, certificate, executable/permission, abort/buffer,
transport and consent errors). Arbitrary messages, URLs, headers, JSON values,
and raw exception causes are withheld. Unknown diagnostics are explicitly
reported as unrecognized; this deliberately does not promise full arbitrary
message preservation. ECONNREFUSED/ECONNRESET/ENOTFOUND/ETIMEDOUT point to
connectivity/DNS; certificate codes to trust configuration; ENOENT/EACCES to
executable availability/permissions. A recognized token is a diagnostic hint,
not proof of the originating cause. No raw error is added to the journal.

No automatic retry or receipt reconstruction occurs. A dry run after a failed
attempt inspects remote state without completing the journal. Even if an external
deployment is healthy, status alone cannot prove its content matches the local
assets. A later explicitly authorized deployment can establish a new receipt;
it skips already-applied SQL and verifies the function again. Do not manually
mark an incomplete journal complete. A process killed before cleanup can leave a
lock: confirm no deployment is running and inspect remote progress before
removing that lock. Do not remove the journal to bypass reconciliation.

### Rebuild and reinstall on the MiniBook

From a checkout containing the diagnostic commit, with supported Node 24 or 26
and the repository's pnpm version, run:

```bash
pnpm install --frozen-lockfile
mkdir -p /tmp/supagame-diagnostic-package
pnpm --filter @retrobreeze/supagame-cli pack --pack-destination /tmp/supagame-diagnostic-package
npm install --global /tmp/supagame-diagnostic-package/retrobreeze-supagame-cli-0.1.0.tgz
hash -r
command -v supagame
supagame --version
```

Packing runs the prepack build and asset verification; it does not publish.
If building on another machine, transfer that exact tarball to the same path on
the MiniBook and run the last four commands there. The version remains 0.1.0;
retain the source commit and tarball checksum to identify this build. Use the
same npm prefix as the previous global installation. No SDK reinstall is needed.
`private: true` remains unchanged.

From the existing consumer project, these commands perform read-only inspection:

```bash
supagame doctor --remote --project-ref hbizuovcawypckpkmkjj
supagame deploy --dry-run --project-ref hbizuovcawypckpkmkjj
```

They do not reproduce the mutating function step. Capturing its improved error
requires a separately authorized future deployment; none was performed for this
change. Do not run direct deployment merely to collect diagnostics.

Verification for this change: `pnpm test` passed (584 tests); CLI typecheck,
build, focused ESLint with zero warnings, and packing passed. The deployment and
subprocess regression suite passed on Node 24.22.3 and 26.13.0. Real CLI
capability/JSON/consent tests passed for Supabase 3.0.0 and 3.1.0 on both Node
versions, using a localhost synthetic API. Select a test binary with
`SUPABASE_TEST_BINARY=/absolute/path/to/supabase node --test tests/cli/supabase-compatibility.integration.ts`.
These tests do not verify a hosted upload or reproduce the MiniBook failure.
Node 26.9.0 specifically was not tested. Database/API/browser integration suites
were not rerun: no SQL, service runtime, or browser code changed.

# Troubleshooting

Start with `supagame doctor` from the selected project root. It is read-only and
reports **healthy**, **warning**, **error**, **action required**, or **cannot verify**, with local,
database and remote provenance. Add `--local` for the running local database.
Never interpret “cannot verify” as a successful security check.

| Symptom | Check and remedy |
| --- | --- |
| `supagame` not found / npm package unavailable | v0.1 is unpublished. Build and install the local tarballs as in [quickstart](quickstart.md); use `npx --no-install supagame` from the consumer project. |
| No `supabase/config.toml` | Run `supagame init --project-ref <ref> --origin <origin>`, or pass the correct `--workdir`. Supagame does not search parents. |
| Missing/mismatched project ref | Compare explicit ref, `supagame.config.json` and Supabase link metadata. `project_id` is not a hosted ref. Never guess or silently relink another project. |
| Conflicting file/migration | Restore original SDK files from Git or resolve unrelated filename collisions deliberately. Applied migrations must not be renamed/rewritten. Dry-run before staging. |
| Unsupported CLI | Install **Supabase CLI 3.0.0**. The adapter fails closed on untested versions/output shapes; upgrading the executable alone is insufficient. |
| Anonymous sign-in fails | Run `supagame deploy --project-ref <ref>` to preview and authorize the hosted prerequisite. Existing local disablement requires review of `auth.enable_anonymous_sign_ins`. Check Auth quotas/CAPTCHA, network and clock. The SDK helper does not collect CAPTCHA tokens. |
| Existing session fails refresh | Recover through the caller-owned Supabase client. Do not force anonymous sign-in to mask an error and replace a permanent identity. |
| Browser receives 403/CORS errors | Run `supagame config origins add <origin>`, then preview/deploy. Unknown hosted values require all intended origins and explicit `--replace-origins`. The demo uses `http://127.0.0.1:5173`, different from `http://localhost:5173`. Restart local Edge runtime after config changes. |
| Public read receives 401 | Supply a modern `sb_publishable_...` key; preserve `verify_jwt=false` for this mixed-auth Edge Function. Check the key belongs to this project. |
| Protected request receives 401 | Also send a current Auth user JWT. Check issuer, audience, expiry and role. Local Docker usually needs the external `SG_AUTH_ISSUER` override shown in quickstart. |
| Generic 500 / function cannot load | Check staged DTO/lock/config files and server-side configuration. Use doctor and local typechecks. Investigate logs privately; never post keys, tokens or status JSON. |
| Missing/disabled leaderboard | The API intentionally returns the same 404. Ensure its generated migration was applied to the selected database. |
| `INVALID_SCORE` | Use numeric safe integers within inclusive board bounds. `time` does not automatically convert seconds/milliseconds. |
| `DUPLICATE_KEY_CONFLICT` | A key was reused with a different score for the same player/board. Retry unchanged attempts; use a new UUID only for a genuinely new attempt. |
| `RATE_LIMITED` | Ten valid new attempts per player/board in rolling 60 seconds. Equal/worse attempts count. Wait before retrying; same-key replays do not consume more quota. |
| Cursor rejected / rows move | Keep `nextCursor` opaque and on its originating board. Do not round timestamp precision. Restart paging after score/visibility changes; no cross-request snapshot is promised. |
| Lost anonymous profile | Check the original browser/storage. An unlinked anonymous identity generally cannot be recovered after credential loss. The SDK does not merge accounts. |
| Network failure during submission | The server may have committed. Retry the same board, score, player and `submissionKey`; do not generate a new key to retry an uncertain outcome. |
| Demo cannot start | Set the two public `.env.local` variables, restart Vite, enable anonymous Auth, create both boards, and allow the browser origin. Never substitute a secret key. |
| Demo says retry previous attempt | A transport/response failure left the attempt uncertain. Select its original board and score and retry. Reload loses the demo's in-memory attempt key; production games should persist attempts when needed. |

## Local tests and Docker

Use Node 24 and the frozen pnpm lockfile. The regression fixture uses ports
55430–55433 and Docker network `supagame-schema-tests-local`. Create the network
with the loopback binding option shown in the root README before `pnpm api:start`.
The E2E fixture instead creates unique IDs, its own network and ephemeral loopback
ports, then removes only its own resources. It never invokes hosted commands or
Docker-wide pruning.

If Chromium is missing, run `pnpm exec playwright install --with-deps chromium`.
A fresh runner needs network access for npm packages, browser binaries, Deno
modules and Docker images. Package installation runs with npm scripts disabled.

If a process was forcibly killed before cleanup, inspect Docker names first.
Only remove the specific `supagame-e2e-<id>` project/network created by that run.
Do not run `supabase stop --all`, `docker system prune`, or delete another
project's volumes. The test reports cleanup failures rather than assuming success.
For the stable regression fixture use `pnpm db:stop`.

## Hosted deployment failures

Hosted mutation paths have not been independently tested in this repository.
Deployment unit tests mock remote process execution; real CLI protocol/database
tests use local fixtures. Hosted read-only dry runs have been verified with
Supabase CLI 3.0.0. Before production deployment, perform a separately authorized
staging-project verification with your own credentials and backup/recovery process.

`supagame deploy --project-ref <ref> --dry-run` contacts the selected project for
read-only inspection. A missing/ambiguous inventory fails closed. Every pending
migration, including unrelated SQL, is displayed. Review actual SQL contents;
filename/hash previews cannot guarantee its effects.

If direct Supabase CLI commands work but Supagame inspection fails on Linux,
check that the launching session can access its saved login through Secret Service.
Supagame preserves `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` for credential
store discovery; older CLI tarballs stripped both and could fail migration
inspection with a misleading IPv6 error. Rebuild, repack and reinstall the CLI
following the [quickstart](quickstart.md) when using an older local tarball.
Use the reported operation (version check, migration inspection, database preview
or function inspection) to narrow failures. Raw subprocess output remains withheld
because it may contain credentials; do not paste tokens or private CLI output.

Interactive consent is the exact phrase `deploy <ref>`. Noninteractive use requires
`--allow-remote`; `CI`, Supabase environment flags or a previous approval are not
accepted as implicit consent for a new invocation. A changed target or changed
files after confirmation requires a new preview.

Deployment writes a local `supabase/.temp/supagame-deploy.json` journal and uses
`.supagame-deploy-lock/` to prevent simultaneous attempts. If database progress is
uncertain, inspect the applied migration ledger and partial SQL effects before
retrying. If the database completed but the function failed, the next invocation
reinspects remote state and needs fresh authorization. Never delete the journal,
remove a lock, or rewrite attempted SQL simply to bypass these protections; first
establish that no deploy process is running and reconcile its outcome.

Hosted configuration failures can leave an earlier Auth/origin change applied.
Database/function work does not start until those changes are verified. Rerun
`deploy --dry-run`, inspect the result and authorize the remaining work. Origin
receipts contain public configuration only; a missing receipt never permits an
unknown secret overwrite. Seeds, custom roles, Vault and unrelated configuration
remain excluded. See [installation reference](installation-reference.md).

## Live Leaderboards

`doctor --remote --project-ref <ref>` checks actual triggers, authorization, RLS
and grants. A ledger entry alone is insufficient. Missing database Broadcast
helpers require the full local Supabase stack or repair of hosted service
provisioning; do not manually create service-owned Realtime tables. Extra permissive
receive policies require review because they can broaden access across topics.

A suspended/unhealthy hosted Realtime service requires operator attention. The CLI
never flips global `private_only`, resumes services or changes quotas. If only
service-health evidence is unavailable, an optional exported `SUPABASE_ACCESS_TOKEN`
with appropriate read permissions enables the supported Management API checks.
The token is not needed for normal CLI-login-based deployment. WebSocket delivery
still requires a real gameplay check; doctor does not generate artificial scores.

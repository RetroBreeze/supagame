# Installation and hosted configuration reference

## Configuration ownership

`supagame.config.json` format version 1 now accepts optional `origins: string[]`.
Old manifests are valid and remain byte-for-byte unchanged when no change is
requested. Origins normalize URL host casing/default ports, deduplicate, and allow
only exact HTTP(S) origins. Limits: 100 entries, 2,048 characters per input and
16 KB serialized. HTTP origins support local/LAN development; use HTTPS in production.

`init --origin <origin>` and `config origins add <origins...>` merge readable local
origins with the manifest. They preserve unrelated `.env` and `.gitignore` lines,
prepare an ignored `supabase/functions/.env`, and supply a loopback Auth issuer
using `api.port` only when no explicit issuer exists. Unsupported/malformed origin
values fail before any writes. Restart the local Edge runtime after changes.
The local environment file is never included in a hosted deployment.

Fresh initialization creates a minimal local config with anonymous Auth and
Realtime enabled. Existing TOML is preserved. Explicit local disablement, overrides
or custom issuers need review; they are not copied to hosted configuration.

## Hosted operations and consent

Deployment uses the pinned Supabase CLI **3.0.0**, explicit `--remote=<ref>`, its
supported Management API transport and existing saved login. No credential-store
internals or dashboard automation are used. No upgrade to CLI 3.1.0 is included.

The CLI uses three separate boundaries:

1. Existing isolated SQL/function deployment and its migration/function journal.
2. A new isolated config declaring **only** `auth.enable_anonymous_sign_ins=true`.
   `config diff` must report complete Auth evidence and only that actionable change.
   Undeclared `remote_only` differences are preserved. After consent, scoped
   `config push --yes` sends only the declared changed property. It never receives
   the developer's TOML, dotenv files, remote overlays or other settings.
3. `secrets set` with a private temporary file containing **only**
   `SG_ALLOWED_ORIGINS`. The hosted secret digest is read back before success.

The narrow Auth request is `PATCH /v1/projects/{ref}/config/auth` with
`external_anonymous_users_enabled: true`; origin installation uses the supported
secrets endpoint. This behavior was checked against the pinned CLI source and
[Auth API](https://supabase.com/docs/reference/api/v1-update-auth-service-config),
[secrets API](https://supabase.com/docs/reference/api/v1-bulk-create-secrets), and
[CLI implementation](https://github.com/supabase/cli/blob/v3.0.0/apps/cli/src/commands/config/push/SIDE_EFFECTS.md).
Full consumer configuration pushes are never used.

The preview combines these with all pending SQL and the named `supagame` function.
Interactive consent is `deploy <ref>`. CI must explicitly pass `--allow-remote`;
environment variables are not consent. A dry run cannot be combined with that flag.
Local files, remote metadata/configuration and origin receipts are rechecked after
consent. Realtime database prerequisites are checked before applying its migration.

Configuration is applied and verified before SQL/function work. There is no
cross-service transaction or automatic rollback. An interrupted write may have
succeeded: rerun the dry run to inspect actual state, then authorize remaining work.
Existing uncertain-database safeguards still prevent blind retries. Neither API
provides a cross-client compare-and-swap guarantee; avoid concurrent administration
from another checkout/dashboard during deployment.

## Existing origin secrets

Supabase's secret inventory returns digests, not recoverable plaintext. Supagame
compares SHA-256 of its serialized origin array. An identical digest can be adopted
without a write. A receipt in `supabase/.temp/supagame-origins.json` records only
public origins, their digest and project ref. If both the receipt and remote digest
match, adding a superset of origins is safe. A removed origin, missing receipt or
remote drift never authorizes overwriting an unknown value.

To migrate deliberately:

```sh
supagame config origins add https://existing-game.example http://localhost:5173
supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
supagame deploy --project-ref YOUR_PROJECT_REF --replace-origins
```

Supply **every** address that must remain allowed. `--replace-origins` authorizes
that replacement choice only; normal deployment authorization is still required.
Losing the receipt does not break the game or reset anything. An identical digest
can be adopted again; otherwise repeat the explicit migration. Legacy manifests
without origins preserve hosted configuration and produce a cannot-verify finding.

## Realtime and diagnostics

Live Leaderboards uses database Broadcast and explicit private channels, not a
Postgres Changes publication. Module migrations own triggers, the restricted
function and receive/send policies. They are never rewritten or recreated based
only on a migration-ledger entry. Doctor checks enabled triggers on the correct
tables/events, fixed search paths, restricted grants, policies, Realtime RLS and
receive prerequisites. Additional permissive receive policies require review;
Supagame does not remove unrelated policies.

The global `private_only` setting is not required for the SDK's explicitly private
channels and is never changed. A readable configuration endpoint is not proof of
service availability. CLI 3.0.0 does not expose suspension/service health; optionally
export `SUPABASE_ACCESS_TOKEN` with read access for direct read-only Management API
checks of [Realtime settings](https://supabase.com/docs/reference/api/v1-get-realtime-config)
and [service health](https://supabase.com/docs/reference/api/v1-get-services-health).
Do not put this token in a project file or command argument. Without it, doctor
reports service health as cannot verify. Suspended/unhealthy service evidence blocks
Live deployment until an operator resolves it. Neither path changes global settings. The supported Realtime PATCH endpoint can
change suspension/private-only/quotas, but doing so affects the entire project and
is reserved for a separate operator decision, especially for administrative or
billing suspension. These settings are not normal module installation steps.

Doctor never creates users, submits scores, broadcasts or obtains player sessions.
WebSocket delivery/reconnect and browser CORS require real gameplay or the local
integration suite. Exit codes: 1 for errors/action required, 2 for requested live
checks with incomplete evidence (the existing advisory HTTP check is excepted),
0 when the requested checks have no blocking/incomplete findings. Warnings remain
advisory. No raw provider error bodies, secret values or credentials are printed.

## Prerequisites that remain outside automatic setup

- Project creation, CLI login and appropriate account permissions.
- Game rules, allowed browser addresses, client URL/publishable key and gameplay integration.
- Review of existing unreadable origin values, intentional conflicting settings,
  custom Auth issuers, signup restrictions/CAPTCHA and suspended services.
- Authorization of every hosted deployment, including upgrades and retries.

Auth/config reads require the CLI's configuration-read permissions; enabling
anonymous Auth requires Auth configuration write access. Origin inspection/write
requires Edge Function secrets read/write respectively. Migration/function deployment
retains its existing permissions. Missing permissions fail closed with a remedy.
Score bounds/rate limits remain abuse controls, not complete anti-cheat protection.

## Admin

`supagame add admin` stages optional administration with core/leaderboard
dependencies. Use `supagame admin doctor --local` or an explicitly selected remote
target to check it. See [commands, security and migration details](admin.md).

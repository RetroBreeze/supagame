# Local Admin Dashboard v1

The dashboard is bundled with `@supagame/cli` 0.1.5. It administers **one configured
project per launch** using the existing optional Admin module. It does not deploy
anything, install a hosted service or add public Edge Function endpoints. No new
database migration is required; Admin module 0.1.4 remains unchanged.

## Prerequisites and installation

- Node 24 and Supabase CLI 3.0.0 on the machine running the dashboard.
- A game directory with `supagame.config.json`, `supabase/config.toml`, consistent
  link metadata, and the Admin module installed and applied to the selected database.
- Existing Supabase CLI operator authentication (for example `supabase login`,
  or the credentials already supported by Supabase CLI in your environment).
- For `--local`, the configured local Supabase database must be running.

The browser needs no Supabase API key, service-role key, database password or
operator access token. Never put those credentials into the launch-code field.

To build and install an unpublished local tarball without deploying:

```sh
cd ~/Projects/supagame
pnpm build
mkdir -p /tmp/supagame-dashboard-pack
pnpm --filter @supagame/cli pack --pack-destination /tmp/supagame-dashboard-pack
cd ~/Projects/vaccoin
npm install --save-dev /tmp/supagame-dashboard-pack/supagame-cli-0.1.5.tgz
```

Use your game's package manager equivalent if it uses pnpm. The install updates
that game's package manifest/lockfile only; review those changes normally. No SDK
update or Supabase deployment is needed for the dashboard. These commands are
instructions, not changes performed against Vaccoin during implementation.

## Launch

From the configured game project:

```sh
npx supagame admin dashboard --remote
npx supagame admin dashboard --local
npx supagame admin dashboard --remote --port 4173
npx supagame admin dashboard --remote --workdir ~/Projects/vaccoin
```

Choose exactly one of `--local` or `--remote`. Hosted mode is never inferred. The
default HTTP port is 4173. `--port` accepts an integer from 1 to 65535; port 0 and
non-loopback bind options are not supported. No browser is opened automatically.

The CLI verifies the selected target, installed Admin security/migration state
and operator role before starting. It prints the local address, environment,
project ID/reference and a private **launch code**. Open the address and paste
that code to unlock the dashboard. Merely opening localhost does not grant access.

The project label is the configured `project_id`; the Supabase reference is the
manifest's reference, checked against all existing link metadata. It is not a
name guessed from your credential's account. Keep the terminal and its launch
code private; anyone holding that code and able to reach the loopback listener
can administer this session's project.

## SSH forwarding

On the remote machine:

```sh
cd ~/Projects/vaccoin
npx supagame admin dashboard --remote --port 4173
```

On the client:

```sh
ssh -L 4173:127.0.0.1:4173 shem@corebook
```

Then open:

```text
http://localhost:4173
```

Enter the launch code printed in the remote terminal. The dashboard listens only
on `127.0.0.1`, never `0.0.0.0`. From another machine it is reachable through the
configured SSH tunnel, **not directly over the LAN**. Keep the local and remote
forwarding ports equal; exact Host and Origin validation intentionally rejects
other addresses, reverse proxies and custom domains. Do not expose the SSH client
listener to the LAN with `-g` or a wildcard bind address.

## Views and actions

- **Overview:** fixed project/environment, locally recorded module versions,
  startup security status, actual leaderboard/profile counts, warnings and
  recent committed activity. The player count is stored profiles, not all Auth users.
- **Leaderboards:** up to 100 boards with type, sort direction, state, generation,
  administrative revision, active player count and retained submission count.
  Inspect any board by ID, review generation history, preview reset, disable or enable.
- **Score moderation:** enter a board ID; browse accepted events in 50-row keyset
  pages. Filter by exact submission/player UUID and optional generation. Inspect,
  hide or restore scores. This does not fabricate rejected-request history.
- **Players:** search display names or exact UUIDs across up to 50 matching
  profiles. Inspect an exact Auth UUID even if its profile does not exist yet.
  Restrict/reinstate score submission eligibility. Accounts, profiles, saves,
  achievements and sessions remain intact. Anonymous restrictions cannot prevent
  someone creating a new anonymous identity.
- **Audit:** the latest 100 committed administrative operations, with local text
  filtering by action, target, reason and operation ID. Attribution is the database
  session role (such as `postgres`), not a uniquely identified human operator.

Views use existing tables through bounded, fixed read-only queries. Board history
and operation inspections reuse the existing Admin inspection functions/builders.
Counts may scan existing rows; operator subprocesses are limited to 30 seconds.
For extremely large installations, a count or filtered read may time out rather
than present an invented or partial metric. Pagination is a live view, not a
historical snapshot while new submissions arrive.

## Preview, confirmation and retries

Every modifying action follows the same workflow:

1. Fetch current state and create a server-owned preview (10-minute lifetime).
2. Review the project, environment, target, impact and original revision.
3. Enter a reason, which is recorded in the existing audit log. Do not include secrets.
4. Type the exact target identifier. Reset requires the leaderboard ID.
5. Confirm explicitly. Only then does the server call `sg_private.admin_apply`.
6. Display the actual database result and refresh the view.

There is no one-click reset. Reset retains historical events but starts a fresh
active generation; it has no automatic undo command. Hide retains the score and
moderation history; restore respects the active generation. Enable/disable and
restrictions/reinstatement are reversible.

The server generates the operation UUID and keeps its action, target and original
revision. The browser cannot supply another project, revision, SQL statement,
connection or workdir. Configuration is checked again before execution; database
revision and authorization checks remain authoritative inside the transaction.

If a response is lost, the dashboard reports an unknown outcome. **Retry same
operation** uses the original UUID, revision and reason. It never automatically
retries with a new UUID. The reason/confirmation become locked after the first
attempt. A successful duplicate shows the original result. Stale revisions require
reviewing a new preview. If a preview expires or the process/browser restarts,
inspect audit history for the displayed UUID before creating another action.

## Security and session lifecycle

- Only 127.0.0.1 is bound; IPv6/wildcard listeners and browser project switching
  are absent. Target resolution follows the existing no-parent-search rules.
- Each launch generates a cryptographically random 256-bit launch code. The code
  is exchanged for a session bearer and separate CSRF token. The UI keeps these
  in memory only: no cookies, localStorage, sessionStorage or URL credentials.
  Reloading requires login again. Browser sessions expire after eight hours.
- Every API request needs an exact same-origin header, validated Host and JSON
  body. After launch-code authentication, requests also require a session bearer
  and CSRF token. Cross-origin/preflight requests have no CORS grant.
  DNS-rebinding names, forwarded hosts, unexpected fields/routes/methods and
  cross-site Fetch Metadata are rejected.
- CSP blocks inline scripts, third-party resources, frames and form navigation.
  All database-controlled strings are rendered as text, never HTML.
- JSON bodies are capped at 16 KiB, request/header timeouts at 10 seconds, idle
  sockets at 40 seconds and Supabase subprocesses at 30 seconds. At most eight
  requests and eight sessions are active; each session retains up to 100 previews.
  Ten invalid launch-code attempts trigger a one-minute login cooldown.
- Privileged credentials remain in the server's existing Supabase CLI transport.
  The shared Admin service is called directly; it does not spawn Supagame commands.
  It still invokes the official Supabase CLI for authenticated database queries.
  Errors are sanitized; raw process output and credentials are not returned.
- Press **Ctrl+C** or send **SIGTERM** to stop. The server closes its listener and
  connections, invalidates sessions/previews, aborts owned subprocesses and removes
  its isolated workdir. Database operations already committed remain committed;
  interrupted responses require checking audit history.

This is trusted project-operator access, not delegated in-game administration.
Loopback HTTP assumes a trusted operating system, browser and SSH client. It
cannot defend against malware, a privileged local process, a malicious browser
extension, or someone who can read your terminal's launch code. The owner retains
SQL recovery powers; the audit is not tamper-proof against the database owner.
Browser lock clears the current UI's credentials; terminate the CLI to revoke all
sessions. Browser extensions are outside CSP's protection.

## Troubleshooting

- **No config/Admin:** launch from the exact configured game root or set
  `--workdir`. Install and deploy Admin separately using the existing CLI workflow.
- **Reference mismatch:** reconcile manifest and Supabase link metadata. The
  dashboard deliberately does not offer a project selector or override.
- **Authentication/operator denied:** verify `supabase --version` is 3.0.0 and
  authenticate with the existing CLI. Run `supagame admin doctor --remote
  --project-ref <ref>` (or `--local`). A player JWT or service-role API key is not
  sufficient for these operator-only functions.
- **Port in use:** choose another `--port`, and use that same port in your SSH tunnel.
- **Host/Origin rejected:** use exactly the printed 127.0.0.1 URL or
  `http://localhost:<port>` through the tunnel. Do not use a LAN address or proxy.
- **Configuration changed:** stop and restart. The session will not switch projects.
- **Session/preview expired:** log in again with the terminal code, or relaunch if
  necessary. Check audit history before repeating a potentially committed action.
- **Network or query timeout:** restore the operator connection; inspect the audit
  and retry the original preview only. The UI never reports success without a
  successful, structurally valid database result.

See [verification results](admin-dashboard-verification.md) for coverage and test limits.

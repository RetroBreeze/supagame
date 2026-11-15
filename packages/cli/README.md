# @retrobreeze/supagame-cli

Provision game services in **your own Supabase project**, for Unity, Godot,
Unreal, browsers or a custom engine. The CLI generates backend configuration,
SQL migrations and Edge Function assets. It generates no game-client source,
framework files or JavaScript runtime requirement for your game.

The executable is **supagame**. Version **0.1.0** is still unpublished and all
packages remain private. Use [local tarballs](../../RELEASING.md) before release.
After publication, install the CLI and a supported Supabase CLI in your game root:

```sh
npm install -D @retrobreeze/supagame-cli
npm install -D --save-exact supabase@3.1.0
npx supagame init
```

Use **Node.js 24 or 26** and exactly **Supabase CLI 3.0.0 or 3.1.0**. These are
build/provisioning tools, not game runtime requirements. Supagame never installs
global dependencies. The repository dependency stays pinned to 3.0.0.

## Guided initialization

In a terminal, `init` checks Node/Supabase versions, local configuration, existing
installation and link metadata. It checks account access with the supported
Supabase CLI and offers its normal login flow when access fails. No credential
files are read by Supagame. Login is optional: you can enter a reference manually
and prepare local files with hosted access explicitly unverified. Login may save
Supabase credentials even if you later cancel local setup.

Choose an accessible project or enter its reference. Existing manifest/link
references must agree; Supagame never switches or relinks your hosted project.
Choose services, optional browser origins and an optional public connection export.
All currently available services depend on Core and Leaderboards; setup explains
and includes those prerequisites. Admin provides operator tools rather than a
required game-client integration. Existing services and exact origins are retained.

Before writing, setup shows the project, modules and every planned file. Declining,
Ctrl-C or EOF writes no project configuration. All selected modules and the optional
export use one file transaction; file conflicts stop it, and ordinary write failures
roll back. A hard process/machine interruption retains the existing staging recovery
rules. **Initialization never deploys.** Review and commit the generated files.

Native engines can skip browser origins. Browser games supply exact HTTP(S)
origins without paths or wildcards. Existing TOML and unrelated files are preserved;
JSON/JSONC-only Supabase projects require manual conversion first. `--workdir`
selects an exact root, without searching parents.

```text
SUPAGAME · INIT
? Supabase project: My Arcade (abcdefghijklmnopqrst)
? Which Supagame services would you like?: achievements
Selected services include their Core and Leaderboards prerequisites.
? Configure browser origins? Native engines can skip this. (y/n) [n]: n
? Export public connection information as JSON? (y/n) [n]: n
SUPAGAME · READY TO INITIALIZE
Reference   abcdefghijklmnopqrst
Modules     core, leaderboards, achievements
create supabase/migrations/...
create supabase/config.toml
create supagame.config.json
? Apply configuration? (y/n) [y]: y
```

Selections accept listed numbers or values; multiple selections use commas.
`init --interactive` explicitly opens optional setup questions again. Existing
installations otherwise repeat safely without prompts. Fully specified
`init --project-ref <ref>` retains its local/offline behavior; it does not require
account discovery or install any service unless `--module` is supplied.

## Guided definitions

```sh
npx supagame leaderboard create target-rush
npx supagame achievement create first-win
```

Missing leaderboard options prompt for points/time, ascending/descending ranking,
and optional safe-integer bounds. Enter `none` for an unbounded side; a bound is
not invented from the score type. **Keep best is always true**, enforced by the
backend. Time units are your game's choice. A summary and file preview precede
confirmation. Existing IDs/SQL remain immutable.

Achievements prompt for missing title, description, an installed descending board,
and a nonnegative safe-integer threshold. Optional icon/category/metadata stay
explicit flags. Install Achievements and define its board first. Complete commands
never prompt, even in a terminal; omitted optional bounds remain unbounded.
`--dry-run` collects missing settings and previews files without asking to write.

## Explicit commands and automation

```sh
npx supagame init --project-ref YOUR_PROJECT_REF --module leaderboards --module achievements --no-interactive
npx supagame leaderboard create target-rush --type points --order desc --keep-best --min 0 --max 1000000 --no-interactive
npx supagame achievement create first-win --title 'First win' --description 'Reach 100 points' --board target-rush --threshold 100 --no-interactive
npx supagame add cloud-saves --dry-run --json
npx supagame config origins add https://game.example --no-interactive
npx supagame doctor --json
```

CI, redirected input **or output**, `--no-interactive`, and `--json` disable
questions. Missing required information fails clearly; these options never grant
hosted authorization. `--interactive` cannot override CI or missing terminals.
`NO_COLOR` (including an empty value) disables colors. Redirected output has no
terminal escapes. Progress is static, without animated CI output.

Preview and deployment remain separate, explicitly targeted operations:

```sh
npx supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
npx supagame deploy --project-ref YOUR_PROJECT_REF
# Deliberate hosted authorization for automation; never implied by JSON mode:
npx supagame deploy --project-ref YOUR_PROJECT_REF --allow-remote --json
```

Interactive deployment still requires the exact phrase `deploy <ref>`. Local and
remote state are revalidated afterward. All pending migrations (including unrelated
SQL) remain visible. Only the Supagame function and narrowly scoped configuration
are deployed. Journals, uncertain-outcome refusal and no automatic mutation retry
are unchanged. `--verbose` includes hashes and individual healthy file checks.
Doctor preserves warnings, action-required findings and verification limitations.

## Public connection information

The versioned HTTP API works without a language SDK or a JSON export:

```sh
npx supagame connection
npx supagame connection --json
npx supagame connection --output supagame.connection.json --dry-run
npx supagame connection --output supagame.connection.json
```

The command reuses authenticated CLI access, verifies the explicit/manifest/linked
project identity, reads its key inventory without `--reveal`, and selects only a
modern publishable key. Multiple keys require a choice or `--key-id <id>`.
A project reference never determines the key. Privileged keys, legacy JWT keys,
passwords and access tokens are never exported. No authentication file is read.

```json
{
  "schemaVersion": 1,
  "projectRef": "abcdefghijklmnopqrst",
  "supabaseUrl": "https://abcdefghijklmnopqrst.supabase.co",
  "publishableKey": "sb_publishable_EXAMPLE_PUBLIC_KEY_ONLY",
  "apiBaseUrl": "https://abcdefghijklmnopqrst.supabase.co/functions/v1/supagame/v1"
}
```

`--url https://api.example.com` supports an active custom domain verified through
`supabase domains get` for this project; unknown domains, insecure URLs, credentials,
paths and mismatched refs fail closed. This check depends on Supabase's experimental
[hostname configuration API](https://supabase.com/docs/reference/api/v1-get-hostname-config)
and requires custom-domain read permission. Vanity domains and arbitrary proxies
are not automatically verified. The default URL requires no custom-domain access.

The export is a derived snapshot; deployment never reads it. `supagame.config.json`
remains authoritative. Regenerate after key/domain changes. Identical exports are
no-ops. Different content requires `--replace`, which only replaces a recognized
export for the same project; foreign files and symlinks are refused. Paths are
relative to the selected project root and must end in `.json`; Git, Supabase,
dependency and installer-owned paths are reserved. Guided init can include an export in its
single transaction; explicit init uses `--connection-file <path>`.

## JSON contract and exit codes

Non-Admin commands emit exactly one JSON object to stdout with `--json`, including
errors. No heading, progress line, color or prompt is mixed into the document:

```json
{"schemaVersion":1,"command":"init","ok":true,"result":null,"events":[]}
```

The fields are stable: `schemaVersion: 1`, space-separated `command`, boolean `ok`,
`result` (command data or null), and ordered `events`. Failures additionally have
`error: {category, code, message}`. Categories are `validation`, `authentication`,
`configuration`, `deployment` and `cancelled`. Messages are human guidance; scripts
should use the category/code and structured fields, not parse prose.

Event forms are `{kind: "info"|"success"|"warning"|"error"|"progress"|"heading",
message}`, `{kind:"file",status:"create"|"update"|"unchanged"|"conflict",path}`,
and `{kind:"values",values:{label:value}}`. File contents and credentials are
excluded. `doctor.result.findings` retains every `{scope,id,status,message}`;
`connection.result` is the public connection schema above. Deployment results
contain the inspected project/module/migration/function/configuration preview,
including migration names, ownership and hashes. The success envelope means the
requested operation completed; a dry-run never means deployment occurred.
Other local commands expose file changes through events; `result` may be null.
Additive fields/events may appear within schemaVersion 1; consumers should ignore
unknown fields. Admin inspection `--json` retains its existing raw JSON contract
and exit behavior; it is not wrapped in this envelope. Admin mutation output and
the long-running dashboard retain their existing interfaces.

Exit codes: **0** success, **1** failure (or doctor errors/action required), **2**
doctor requested live checks have incomplete evidence, **130** guided cancellation.
Doctor advisory warnings do not become successes for checks marked cannot verify.
Parse/help errors preserve Commander behavior; `--help` is always human help text.

## Troubleshooting and security

- Missing CLI: install a supported local Supabase dependency; invoke via `npx`.
- Account/project reads fail: run `supabase login`, check networking and permissions,
  or continue local initialization with a manual ref. An export requires readable keys.
- No publishable key: create one in Supabase settings; never substitute a secret key.
- Mismatched target: reconcile manifest and link metadata deliberately. Never guess.
- Conflicting files: inspect the preview; preserve applied migration bytes.
- Interrupted deployment: retain its journal, inspect `doctor --remote` and
  `deploy --dry-run`, then authorize only the reviewed remaining changes.
- Raw deployment diagnostics remain opt-in with `--diagnostic-log <new-file>`;
  this existing mode-0600 file can contain credentials and must stay private.

Supagame does not change SQL, RLS or Edge authentication as part of this setup UI.
Range checks and throttling are not complete anti-cheat protection. Hosted
verification and runtime WebSocket delivery are separate from local/loopback tests.

## Initialize the SDK, submit and read scores

Run this TypeScript in your browser application. Replace the two public connection
values; use your existing Supabase client if the application already has one.
Never use a service-role key, secret API key or database password in a game.

```ts
import { createClient } from '@supabase/supabase-js';
import { createGameServices } from '@retrobreeze/supagame-sdk';

const supabase = createClient(
  'https://YOUR_PROJECT_REF.supabase.co',
  'sb_publishable_YOUR_PROJECT_KEY',
);
const game = createGameServices({ supabase });
await game.players.ensureAnonymousSession();
await game.players.updateMe({ displayName: 'Player One' });

const submissionKey = crypto.randomUUID();
const result = await game.leaderboards.submit('arcade', 1250, submissionKey);
console.log(result.outcome, result.bestScore);
const page = await game.leaderboards.getTop('arcade', { limit: 10 });
console.table(page.entries);
const mine = await game.leaderboards.getMine('arcade');
console.log(mine); // null until this player has a score

// Requires the deployed live-leaderboards module and an authenticated session.
const subscription = game.leaderboards.subscribe('arcade', {
  topN: 10,
  onUpdate(page) { console.table(page.entries); },
  onRankChange(event) { console.log(event.previousRank, event.rank); },
  onStatus(status) { console.log(status); },
  onError(error) { console.error(error instanceof Error ? error.message : 'Live update failed'); },
});
// Call when leaving this screen or disposing the game instance.
window.addEventListener('pagehide', () => subscription.unsubscribe(), { once: true });
```

The session helper reuses existing signed-in users. Losing an unlinked anonymous
session can make its identity unrecoverable. Scores must be safe integers; `desc`
keeps larger scores and `asc` keeps smaller scores. Reuse a submission key only
for the same player, board and score when retrying an uncertain submission.
Range checks and rate limits do not prevent plausible fabricated scores.

See the [SDK reference](https://github.com/RetroBreeze/supagame/tree/main/packages/sdk-ts),
[Wiki](https://github.com/RetroBreeze/supagame/wiki) and
[release guide](https://github.com/RetroBreeze/supagame/blob/main/RELEASING.md).
MIT licensed; see LICENSE.

Hosted `supagame deploy` does not require Docker: Edge Functions use Supabase's
API bundling (`--use-api`) from the existing isolated staging directory.
Local Supabase development and database/integration tests ordinarily require
Docker or another supported container runtime. Deployment authorization,
explicit project selection, previews, journals and recovery are unchanged.
API bundling cannot deploy `static_files`; current Supagame templates need no
static assets, and configured static files are rejected before deployment.
See [Supabase's asset limitation](https://supabase.com/docs/guides/functions/wasm).

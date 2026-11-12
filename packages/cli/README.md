# @retrobreeze/supagame-cli

Install and maintain Supagame services in your own Supabase project. The executable
is **supagame**. Proposed npm version: **0.1.0**. Packages remain private until
publication is explicitly authorized; the npm commands below describe the
post-publication workflow. Before then, use the release guide's local tarballs.

## npm quickstart

Use **Node.js 24 or 26** (`^24.0.0 || ^26.0.0`). Supagame's deployment
adapter supports **Supabase CLI 3.0.0 and 3.1.0** (`3.0.0 || 3.1.0`).
Other releases, including prereleases and untested patches, are rejected. Install it locally so `npx supagame` can find it on PATH. The SDK needs
the caller-owned Supabase JavaScript client (`^2.119.0`, tested at 2.119.0).

From the root of your existing game project:

```sh
npm install -D @retrobreeze/supagame-cli
npm install -D supabase@3.1.0
npm install @retrobreeze/supagame-sdk @supabase/supabase-js@2.119.0
npx supabase --version
npx supabase login
npx supagame init --project-ref YOUR_PROJECT_REF --origin http://localhost:5173
npx supagame add leaderboards
npx supagame leaderboard create arcade --type points --order desc --keep-best --min 0 --max 1000000
# Optional: required for the live subscription example below.
npx supagame add live-leaderboards
npx supagame deploy --project-ref YOUR_PROJECT_REF
npx supagame doctor --remote --project-ref YOUR_PROJECT_REF
```

Replace `YOUR_PROJECT_REF` with the reference of your existing Supabase project
and the origin with your game's exact browser origin. `init` records the reference
locally, preserves existing Supabase configuration and rejects conflicting links.
If your project already records its reference, `npx supagame init` reuses it.
Supagame currently manages `supabase/config.toml`; review conversion of JSON or
JSONC-only projects before initialization. Do not keep ambiguous configuration
formats for administration. Deployment uses an isolated TOML workspace and
checks required CLI flags before hosted changes.
Commit the generated configuration, migrations and function files.

The repository dependency remains pinned to 3.0.0; CI separately selects verified
3.0.0/3.1.0 binaries. See the [compatibility evidence and hosted limitations](https://github.com/RetroBreeze/supagame/blob/main/SUPABASE-COMPATIBILITY.md).

`deploy` previews the exact destination and pending migrations, then asks for
confirmation before hosted changes. It configures anonymous Auth, origins,
permissions and the function as required. Run interactively; unattended deployment
requires explicit `--allow-remote`. Never approve a destination you do not recognize.
These commands are instructions for your later deployment; release validation
itself only uses local synthetic fixtures.

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

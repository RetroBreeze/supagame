# Install Supagame in your game

Supagame adds player identities, leaderboards and optional live updates to **your
Supabase project**. You choose the game features and browser addresses; the CLI
prepares the database, permissions, functions and hosted prerequisites.

## Install

The packages are currently unpublished. From the Supagame checkout, using Node
**24.22.2** and pnpm **12.18.0**:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p artifacts
pnpm --filter @supagame/contracts pack --pack-destination "$PWD/artifacts"
pnpm --filter @supagame/sdk-ts pack --pack-destination "$PWD/artifacts"
pnpm --filter @supagame/cli pack --pack-destination "$PWD/artifacts"
```

From your game directory (adjust the tarball paths):

```sh
npm install --save-dev supabase@3.0.0 ../supagame/artifacts/supagame-cli-0.1.0.tgz
npm install @supabase/supabase-js@2.119.0 ../supagame/artifacts/supagame-contracts-0.1.0.tgz ../supagame/artifacts/supagame-sdk-ts-0.1.0.tgz
```

Keep Supabase CLI pinned to **3.0.0**; 3.1.0 is not supported yet. TypeScript apps
that check dependency declarations also need `@types/node@24.19.2` as a development
dependency. Nothing in this workflow publishes packages.

## Create your project and sign in

Create a project in Supabase, copy its project reference, then authenticate:

```sh
npx --no-install supabase login
```

The CLI reuses this login. Never put access tokens or privileged keys in game code.

## Choose features and browser addresses

Replace `YOUR_PROJECT_REF` with the reference of your new or existing project:

```sh
npx --no-install supagame init --project-ref YOUR_PROJECT_REF --origin http://localhost:5173
npx --no-install supagame add leaderboards
npx --no-install supagame add live-leaderboards
npx --no-install supagame leaderboard create arcade --type points --order desc --keep-best --min 0 --max 1000000
```

`init` prepares a local Supabase configuration when one is absent and preserves
existing settings. `--origin` is repeatable. It also prepares local browser
configuration without exposing unrelated environment values. Choose each board's
name, score range and whether larger (`desc`) or smaller (`asc`) is better.

Add another browser address later:

```sh
npx --no-install supagame config origins add http://10.0.0.15:5173
```

Origins are exact scheme/host/port addresses. Wildcards, credentials and URL paths
are rejected. Adding origins preserves existing entries. Local commands support
`--dry-run` and can be repeated safely. Use `--workdir` to select another game root.

## Preview and deploy

```sh
npx --no-install supagame deploy --project-ref YOUR_PROJECT_REF --dry-run
npx --no-install supagame deploy --project-ref YOUR_PROJECT_REF
```

Read the destination, module list, migrations, function update and hosted
configuration plan. Type **`deploy YOUR_PROJECT_REF`** to authorize the changes.
The CLI enables anonymous player authentication if needed and installs browser
origins. Live Leaderboards includes its triggers and private-channel authorization;
no copy-paste SQL or dashboard policy setup is needed on a normally provisioned
project. Global Realtime settings and unrelated configuration are preserved.

Existing projects with an unreadable origin setting get a clear migration step:
record **all** addresses that should remain allowed, review the preview, then add
`--replace-origins` to the deployment command. That flag does not replace the
normal authorization prompt. See [configuration reference](installation-reference.md).

## Verify and connect your game

```sh
npx --no-install supagame doctor --remote --project-ref YOUR_PROJECT_REF
```

Doctor reports **HEALTHY**, **ACTION REQUIRED**, **ERROR**, or **CANNOT VERIFY**
(and advisory warnings). Follow the specific remedy for any failed check. A missing
code receipt or untested browser/WebSocket connection is reported honestly; a
migration record alone never proves that Live Leaderboards works.

Use your project's URL and **publishable** key in the game:

```ts
import { createClient } from '@supabase/supabase-js';
import { createGameServices } from '@supagame/sdk-ts';

const supabase = createClient(PROJECT_URL, PUBLISHABLE_KEY);
const game = createGameServices({ supabase });
await game.players.ensureAnonymousSession(); // reuses an existing session
await game.players.updateMe({ displayName: 'Player One' });
const top = await game.leaderboards.getTop('arcade', { limit: 10 });

const live = game.leaderboards.subscribe('arcade', {
  onUpdate: page => renderLeaderboard(page.entries),
});
// When the screen closes:
live.unsubscribe();
```

Submit scores from actual gameplay with `game.leaderboards.submit('arcade', score)`.
Scores must be safe integers. See [Live Leaderboards](live-leaderboards.md) for
subscriptions and [local development](local-development.md) for the browser demo.

## Add a feature or upgrade later

```sh
npx --no-install supagame add live-leaderboards --dry-run
npx --no-install supagame add live-leaderboards
npx --no-install supagame deploy --project-ref YOUR_PROJECT_REF
```

After installing a newer compatible CLI package:

```sh
npx --no-install supagame upgrade --dry-run
npx --no-install supagame upgrade
npx --no-install supagame deploy --project-ref YOUR_PROJECT_REF
npx --no-install supagame doctor --remote --project-ref YOUR_PROJECT_REF
```

Existing manifests and applied migrations remain valid. Upgrades are additive;
modified files require review. Commit the manifest, migrations, staged function
assets and Supabase configuration. Keep environment files and temporary receipts
out of Git. Do not recreate or reset your project.

Project creation, CLI authentication, choosing score rules/addresses and connecting
your game remain your responsibilities. Suspended services, missing account
permissions, custom issuers or deliberate conflicting settings need operator review.
Normal installation does not require navigating multiple dashboard pages.
See [troubleshooting](troubleshooting.md) for concrete remedies.

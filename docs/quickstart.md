# Quickstart: install and play locally

Supagame installs into **your** Supabase project. Games use its HTTP API or the
TypeScript SDK. No Supagame-hosted backend is involved.

The packages are private/unpublished at v0.1 review time. Use the source checkout
and local tarballs below; `npm install @supagame/sdk-ts` from the registry is not
yet a supported installation instruction. Package names remain provisional.

## Requirements

- Node **24 LTS** (repository pin: 24.22.2), pnpm **12.18.0**.
- Docker running, enough disk/memory for Supabase containers, and available local ports.
- Supabase CLI **3.0.0**, pinned in this repository. The deployment/doctor adapters
  deliberately reject other versions, including 3.1.0, until separately tested.
- For the browser E2E test: `pnpm exec playwright install --with-deps chromium`.

From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm -r build
mkdir -p artifacts
pnpm --filter @supagame/contracts pack --pack-destination "$PWD/artifacts"
pnpm --filter @supagame/sdk-ts pack --pack-destination "$PWD/artifacts"
pnpm --filter @supagame/cli pack --pack-destination "$PWD/artifacts"
pnpm test:packages
```

Packing does not publish anything. Keep the contracts tarball alongside the SDK:
the SDK declarations depend on it. The SDK peer is `@supabase/supabase-js ^2.119.0`;
2.119.0 is the version tested here.

## Prepare an existing Supabase project

For a new local project, create a directory beside the checkout (the commands
below assume the checkout directory is named `supagame`):

```sh
mkdir ../my-game
cd ../my-game
npm init -y
npm install --save-dev supabase@3.0.0 typescript@5.9.3 @types/node@24.19.2 ../supagame/artifacts/supagame-cli-0.1.0.tgz
npm install ../supagame/artifacts/supagame-contracts-0.1.0.tgz ../supagame/artifacts/supagame-sdk-ts-0.1.0.tgz @supabase/supabase-js@2.119.0
npx --no-install supabase init
```

The pinned Supabase JavaScript peer includes Node types in some declarations.
`@types/node` above is a development-only type dependency for full declaration
checking; it does not add Node runtime code or browser polyfills.

If `supabase/config.toml` already exists, preserve it and skip `supabase init`.
Supagame operates in the current project root; `--workdir <directory>` selects
another explicit root. It does not search parent directories.

Enable anonymous users in the existing `[auth]` section:

```toml
[auth]
enable_anonymous_sign_ins = true
```

Edit the existing section, rather than adding a duplicate. Keep `sg_private` out
of `[api].schemas`. These are **local** settings; hosted Auth is configured
separately in the project's Auth settings.

Initialize the manifest and stage the module:

```sh
npx --no-install supagame init --project-ref abcdefghijklmnopqrst
npx --no-install supagame add leaderboards
npx --no-install supagame leaderboard create level-1 --type time --order asc --keep-best --min 0 --max 1000000
npx --no-install supagame leaderboard create arcade --type points --order desc --keep-best --min 0 --max 1000000
```

`abcdefghijklmnopqrst` is a **local-only placeholder**, recorded without contacting
a hosted project. For an existing linked project, use its real 20-character ref;
the explicit ref, manifest and any local link metadata must agree. Never deploy
using the placeholder. `init` requires a ref even for local-only development;
`project_id` is a local Docker identifier, not a remote destination.

`init`, `add`, leaderboard creation and `upgrade` support `--dry-run`. Repeating
identical commands is safe. Conflicting files or definitions cause an error;
Supagame does not overwrite them. Commit `supagame.config.json`, generated SQL,
staged function files and `supabase/config.toml` to your project's Git repository.

## Start the local backend

The CLI stages `[functions.supagame]` with `verify_jwt = false`. Preserve it: the
function itself verifies the publishable key and, on protected routes, the user
JWT. Global JWT verification would break public reads with modern publishable keys.

Create `supabase/functions/.env` (keep it out of Git):

```dotenv
SG_ALLOWED_ORIGINS=["http://127.0.0.1:5173"]
SG_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1
```

Use your configured API port if it differs. The local issuer override accounts
for the external loopback URL differing from the Edge container's internal URL.
Do not put privileged keys in this file; the Supabase runtime supplies its own
configuration. Staged `.env.example` files contain public placeholders only.

```sh
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 my-game-local
npx --no-install supabase start --network-id my-game-local
npx --no-install supabase migration up
npx --no-install supagame doctor --local
```

Choose an unused project-specific network name; this Docker network binds published
ports to loopback instead of exposing the local stack to the LAN.

`start` applies migrations on a fresh local database and starts the Edge runtime.
`migration up` applies any later staged migrations; on the first start it can be
a no-op. These CLI v3 commands target the **local** stack; never add `--remote`
while following this local quickstart. Ensure `[edge_runtime].enabled = true`.

Read the local project URL and **publishable key** from `supabase status`. Its
output also contains privileged keys: do not paste the whole output into client
configuration, logs, screenshots or Git. Use only `API_URL` and `PUBLISHABLE_KEY`.
The example intentionally rejects legacy JWT project keys and secret keys.

## Use the SDK

```ts
import { createClient } from '@supabase/supabase-js';
import { createGameServices, GameServicesError } from '@supagame/sdk-ts';

const supabase = createClient(
  'http://127.0.0.1:54321',
  'sb_publishable_REPLACE_WITH_YOUR_PUBLIC_KEY',
);
const game = createGameServices({ supabase });
await game.players.ensureAnonymousSession();
await game.players.updateMe({ displayName: 'Player One' });
const profile = await game.players.getMe();

// Save this key with the attempt if retries must survive a reload.
const submissionKey = crypto.randomUUID();
try {
  await game.leaderboards.submit('level-1', 42500, submissionKey);
  await game.leaderboards.submit('arcade', 1200);
} catch (error) {
  if (error instanceof GameServicesError) {
    // Display error.message. For an uncertain score outcome, reuse its
    // submissionKey with the same board, score and player on a deliberate retry.
    throw error;
  }
  throw error;
}
const top = await game.leaderboards.getTop('level-1', { limit: 10 });
const mine = await game.leaderboards.getMine('level-1'); // entry or null
if (top.nextCursor !== null) {
  const next = await game.leaderboards.getTop('level-1', {
    limit: 10, cursor: top.nextCursor,
  });
}
```

The backend owns ranks, timestamps and player IDs. Smaller is better for `asc`,
larger for `desc`; equal scores keep the original personal best. Safe integer
scores have no implicit units: this example treats time as milliseconds.

The caller's Supabase client owns storage and refresh. Existing anonymous or
permanent sessions are reused. A refresh/auth failure does not silently create
another player. A lost unlinked anonymous session generally cannot recover its
old identity or scores. See [identity linking](security.md#anonymous-identity-and-linking).

## Run the example

Back in the checkout:

```sh
cp examples/capacitor-demo/.env.example examples/capacitor-demo/.env.local
# Edit only the URL and publishable key to match the local backend above.
pnpm --filter @supagame/capacitor-demo dev
```

Open `http://127.0.0.1:5173`. Set your display name, select a board, submit an
integer, and inspect your best and the rankings. See the
[example README](../examples/capacitor-demo/README.md) for Capacitor constraints.

## Hosted deployment: a separate, explicit operation

The steps below describe implemented tooling. **This repository's verification
has not independently exercised a hosted deployment.** First review the exact
project, all pending SQL (including unrelated project migrations), Auth settings,
allowed origins, backups and operational limits. Configure hosted anonymous Auth,
`SG_ALLOWED_ORIGINS`, and any issuer override separately through Supabase's trusted
project settings. Supagame does not deploy config or secrets.

From a project whose manifest and link metadata name the intended real project:

```sh
npx --no-install supagame deploy --project-ref YOUR_REAL_PROJECT_REF --dry-run
npx --no-install supagame deploy --project-ref YOUR_REAL_PROJECT_REF
```

The interactive command requires the exact phrase `deploy <ref>`. Automation must
explicitly pass `--allow-remote`; environment variables are not consent. Underneath,
the adapter uses CLI 3.0.0, explicit `--remote=<ref>` targeting and `--yes` only after
authorization. It deploys all pending migrations and only the `supagame` function;
it excludes seeds, custom roles, Vault synchronization and function pruning.
See [security](security.md) and [troubleshooting](troubleshooting.md) before use.

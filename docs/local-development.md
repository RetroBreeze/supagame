# Local development reference

Complete package installation and module staging in the [quickstart](quickstart.md)
first. Docker is needed only for local backend testing. These instructions use
synthetic local users and never target a hosted project.

## Start the local backend

The CLI stages `[functions.supagame]` with `verify_jwt = false`. Preserve it: the
function itself verifies the publishable key and, on protected routes, the user
JWT. Global JWT verification would break public reads with modern publishable keys.

`supagame init --origin http://127.0.0.1:5173` prepares the local function
origin allowlist and default loopback Auth issuer in an ignored environment file.
Use your configured API port; existing explicit issuer settings are preserved.
If an existing project explicitly disables anonymous Auth, review that choice and
set `auth.enable_anonymous_sign_ins = true` in its existing local `[auth]` section.
Custom local domains/issuers may need a deliberate `SG_AUTH_ISSUER` override.

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
cp examples/browser-demo/.env.example examples/browser-demo/.env.local
# Edit only the URL and publishable key to match the local backend above.
pnpm --filter @supagame/browser-demo dev
```

Open `http://127.0.0.1:5173`. Set your display name, select a board, submit an
integer, and inspect your best and the rankings. See the
[example README](../examples/browser-demo/README.md) for browser setup and build instructions.

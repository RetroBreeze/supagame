# Target Rush

A small Canvas2D game showing the minimum Supagame leaderboard flow: enter a name,
play a round, and submit its score. The title screen lists the top 10; the database
keeps each player's highest score. On small screens, scroll the score list.

## Connect and run

In your Supagame backend project, install the `leaderboards` module and create a
points board named **`target-rush`**, ordered descending, with best-score retention:

```sh
supagame leaderboard create target-rush --type points --order desc --keep-best --min 0
```

Use the [CLI setup guide](../../packages/cli/README.md) to initialize and deploy the
backend if needed. Enable anonymous Auth and allow `http://127.0.0.1:5173` in
`SG_ALLOWED_ORIGINS` (or your exact browser origin). The browser needs only the
project URL and its `sb_publishable_` key, never a service-role or secret key.

From the repository root, with Node.js 24 or 26 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm --filter @retrobreeze/supagame-sdk... build
cp examples/target-rush/.env.example examples/target-rush/.env.local
# Edit .env.local with your backend's URL and publishable key.
pnpm --filter target-rush dev --port 5173 --strictPort
```

Open `http://127.0.0.1:5173`. Restart Vite after changing `.env.local`.
Without configuration, gameplay still works and the page explains why scores
cannot be saved. `pnpm --filter target-rush build` generates static assets in
`examples/target-rush/dist`.

## The integration

**[`src/leaderboard.ts`](src/leaderboard.ts)** contains all Supagame calls:

1. `getTop('target-rush', { limit: 10 })` reads public scores without signing in.
2. After a round, `ensureAnonymousSession()` reuses an existing session or creates
   an anonymous player. Supabase persists and refreshes that session.
3. `updateMe({ displayName })` saves the entered name, then `submit('target-rush',
   score)` sends the attempt. These are separate API calls: names belong to player
   profiles, so changing a name also changes it beside an existing best score.
4. The database retains the best score, the results screen reports it, and the
   top 10 refreshes. Play again returns to the title screen to edit the name.

The SDK generates an idempotency key and reuses it for its automatic network
retry. This example has no offline queue or manual retry flow. A failed request
shows a message without interrupting gameplay. Losing browser storage can lose
access to an unlinked anonymous identity. Client-generated scores can be forged;
server validation and rate limits are not complete anti-cheat protection.

**[`src/main.ts`](src/main.ts)** connects title/results controls and calls the
integration once per completed round. **[`src/config.ts`](src/config.ts)** checks
public connection settings. Names are rendered as text, never HTML.

The remaining modules are independent of the backend: `game.ts` owns round rules
and `ROUND_MS`, `renderer.ts` draws, `input.ts` maps pointer coordinates, and
`audio.ts` supplies sound. Three targets are available at a time; misses or expired
targets reset the streak. Hits 1–5 earn 10 points, 6–10 earn 20, 11–15 earn 30, and
later hits earn 40. The existing `targetrush:roundend` event remains available.

## Verify

```sh
pnpm --filter target-rush test
pnpm --filter target-rush typecheck
pnpm --filter target-rush lint
pnpm --filter target-rush build
pnpm exec playwright install chromium
pnpm --filter target-rush test:browser
```

Browser tests exercise the real SDK with synthetic HTTP responses, mouse/touch
input, and desktop/phone layouts. Screenshots go to `/tmp/target-rush-*.png`.
The repository's `pnpm test:e2e` builds this example against packed SDK artifacts
and verifies name/score persistence and best-only updates on a fresh local
Supabase stack. It requires Docker; no hosted credentials are needed.

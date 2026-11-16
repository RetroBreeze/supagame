# TypeScript integration

Install `@retrobreeze/supagame-sdk` and `@supabase/supabase-js@2.119.0` using the
consumer's package manager. TypeScript consumers also need `@types/node@24.19.2`
for Supabase declarations; include `node` if `compilerOptions.types` is restricted.
This does not require browser Node polyfills. Use Node 24 or 26 for Node consumers.

Reuse the existing Supabase client, including its storage/refresh strategy. If
none exists, create one with `createClient(supabaseUrl, publishableKey)` from
`@supabase/supabase-js`, using public values from `supagame connection`. Do not
use server credentials. Integrate once per appropriate application lifecycle;
avoid submitting on each render/frame.

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { createGameServices, createOperationId } from '@retrobreeze/supagame-sdk';

export async function connectGame(supabase: SupabaseClient) {
  const game = createGameServices({ supabase });
  await game.players.ensureAnonymousSession(); // reuses an existing session
  return game;
}

export async function finishRun(
  game: ReturnType<typeof createGameServices>,
  score: number,
  submissionKey = createOperationId(),
) {
  const result = await game.leaderboards.submit('arcade', score, submissionKey);
  const top = await game.leaderboards.getTop('arcade', { limit: 10 });
  const mine = await game.leaderboards.getMine('arcade');
  return { result, top, mine };
}
```

For durable/uncertain retries, persist the key, board, score and player **before**
calling `finishRun`, and pass that same key. Calling it again with the default
creates a new submission. SDK submit retries one network failure with the same
body/key/identity; HTTP errors are not automatically retried. A submission error
can carry `submissionKey`. Surface `AuthenticationError`, `ApiError.code`,
`NetworkError`, `InvalidParameterError` and `UnexpectedResponseError` separately.
Do not replace Auth on a refresh failure or log underlying tokens.

`players.getMe()` reads a profile; `players.updateMe({ displayName })` accepts
3–24 printable characters. Public `getTop` needs no session. Submit and `getMine`
require one. Pass `nextCursor` unchanged and use returned ranks; pages are not a
cross-update snapshot. Losing an unlinked anonymous session can lose data access.
Provider/account-switch work requires the separate Accounts guide and a stable
`accounts.namespace` with persistence; it is not automatic data merging.

## Achievements and live boards

```ts
import type { GameServices, LiveOptions, Achievement } from '@retrobreeze/supagame-sdk';

export async function attachGameScreen(
  game: GameServices,
  liveOptions: LiveOptions,
  showUnlock: (achievement: Achievement) => void,
  showError: (error: unknown) => void,
) {
  await game.players.ensureAnonymousSession();
  const achievements = await game.achievements.listAchievements();
  const unlocks = game.achievements.onUnlocked(showUnlock, { onError: showError });
  const live = game.leaderboards.subscribe('arcade', liveOptions);
  return {
    achievements,
    dispose() { unlocks.unsubscribe(); live.unsubscribe(); },
  };
}
```

Enable only requested modules and attach only needed listeners. `LiveOptions`
requires `onUpdate(page)` and optionally `topN`, `onRankChange`, `onStatus`,
`onError`. A full Supabase client supplies Auth and Realtime. Only one active
subscription per board per Supabase client is allowed; unsubscribe before
replacement. Best-effort hints trigger authoritative top/personal HTTP reads;
reconnection rehydrates. Initial/reconnect/account-change baselines do not create
rank-change notices. Verify delivery, not just channel configuration.

`getPlayerAchievements()` and `getAchievement(id)` also read current-player
achievement state. `onUnlocked` polls (default 3 seconds), silently hydrates
existing/historical unlocks, then emits new ones. It is not a WebSocket feed.
Call `game.achievements.dispose()` when destroying the whole client. Optional
`createAchievementQueue` is a core export; `mountAchievementNotifications` is
from `@retrobreeze/supagame-sdk/browser`. Keep DOM helpers out of Node/native code.

Public API and exports:
[SDK README](https://github.com/RetroBreeze/supagame/blob/main/packages/sdk-ts/README.md),
[Accounts](https://github.com/RetroBreeze/supagame/wiki/Accounts).

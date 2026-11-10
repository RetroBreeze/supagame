# Achievements

Achievements is an optional game-agnostic module. Definitions belong to your installation, never to the SDK. Version 0.1.1 supports permanent unlocks for a **single accepted score at or above a threshold** on a descending leaderboard. Scores are not summed across runs.

## Install and configure

Use the matching 0.1.1 CLI, contracts and SDK packages. Existing 0.1.0 installations first run:

```sh
supagame upgrade --dry-run
supagame upgrade
supagame add achievements --dry-run
supagame add achievements
supagame achievement create run-coins-500 \
  --title 'Coin Collector' --description 'Collect 500 coins in one run.' \
  --board coins --threshold 500 --icon coin --category single-run
supagame doctor
supagame deploy --dry-run --project-ref YOUR_PROJECT_REF
supagame deploy --project-ref YOUR_PROJECT_REF
```

Replace `coins` with your existing descending board ID. The deployment command previews the exact target and pending migrations and requires explicit hosted authorization. Installation/configuration only stage local files. Repeated commands preserve existing identical files. A conflicting ID or modified migration fails closed. Commit the manifest and generated migrations; do not edit applied migrations.

`--icon`, `--category` and `--metadata '{"rarity":"rare"}'` are optional. Icons are game-owned identifiers or asset references; the SDK does not fetch them. IDs are lowercase alphanumeric/hyphen slugs, 1–64 characters. Titles are at most 120 characters, descriptions 1,000, and thresholds nonnegative JavaScript safe integers. Definitions record a discriminated condition `{type:"score_threshold", leaderboardId, threshold}` in `supagame.config.json`. Rules are immutable through the CLI. Use a new ID for a different condition.

## Retrieval and events

```ts
import { createGameServices } from '@supagame/sdk-ts';
const game = createGameServices({ supabase });
await game.players.ensureAnonymousSession();
const all = await game.achievements.listAchievements();
const progress = await game.achievements.getPlayerAchievements();
const one = await game.achievements.getAchievement('run-coins-500');
const subscription = game.achievements.onUnlocked(achievement => {
  console.log(achievement.title, achievement.description, achievement.icon);
}, { intervalMs: 3000, onError: console.error });
await subscription.ready; // initial hydration attempt, silent
// On scene/application teardown:
subscription.unsubscribe();
game.achievements.dispose(); // stops every subscription on this instance
```

All retrieval methods return definition text, icon, category, metadata, `progress: {current, threshold}`, `unlocked`, `unlockedAt`, and `historical`. `getAchievement` returns null for an unknown ID. The first two methods return the same complete player-scoped list, including locked definitions. Current progress is the player's accepted personal best; it may exceed the threshold. Reads never award or emit events.

The portable HTTP endpoint is authenticated `GET /functions/v1/supagame/v1/achievements`; see `packages/contracts/openapi.yaml`. It accepts no player ID or unlock request. Both anonymous Supabase Auth users and permanent users use their verified JWT.

Subscriptions use serialized polling (default three seconds, minimum 250ms). Initial hydration and identity changes establish a silent baseline. Subsequent newly observed, non-historical unlocks emit once per subscription, in threshold/ID order. Repeated reads, retries and transient reconnects do not repeat events. Callback exceptions cannot stop delivery. Errors go to optional `onError` and polling retries. `ready` means the first attempt completed, not that connectivity was proven. Start a subscription before play. A fresh subscription intentionally does not replay offline/historical awards; persistent unlocks remain available in the list.

## Headless notification queue

```ts
import { createAchievementQueue } from '@supagame/sdk-ts';
const queue = createAchievementQueue(game.achievements, {
  durationMs: 4000, limit: 50, paused: true,
});
const stopRendering = queue.subscribe(current => renderWithYourEngine(current));
queue.resume(); // e.g. results screen; queue.pause() during gameplay
queue.dismiss(); // optional user action
// Teardown:
stopRendering();
queue.dispose(); // unsubscribes, clears timers and queued notifications
```

The queue is framework-independent and imports no DOM code. Multiple unlocks use FIFO order. Duplicate IDs are suppressed for the queue lifetime. The limit includes the current card; overflow drops newest notifications, never persisted achievements. Pause preserves the current card; resume gives it the configured duration. Recreate the queue when changing player identity so queued cards and deduplication belong to the new player. Use `current` and `pending` for Canvas or native renderer integration. Runtime TypeScript polling/queue helpers can be reimplemented over the same HTTP contract in Unity/Godot.

## Optional browser renderer

```ts
import { mountAchievementNotifications } from '@supagame/sdk-ts/browser';
const notifications = mountAchievementNotifications(game.achievements, {
  container: document.querySelector('#notifications')!,
  className: 'my-achievement', durationMs: 4500,
  iconText: id => id === 'coin' ? '🪙' : '★',
});
// Later: notifications.dispose();
```

The helper creates an accessible status region with heading, title, description and a dismissal button. It uses text nodes rather than HTML injection. Supply your own CSS, e.g. `.my-achievement { position:fixed; top:1rem; right:1rem; padding:1rem; background:#123; color:white; }`. No styles or DOM imports are imposed on the core package. The helper uses a star unless `iconText` maps your identifier to display text; use the headless queue for image assets or custom markup.

## Security, transactions and historical migration

Clients have no achievement INSERT/UPDATE/DELETE grants. RLS permits authenticated definition reads and only the current player's unlock rows. The read RPC verifies Auth identity and fixes its security-definer search path. Trusted configuration migrations alone register definitions. A trigger on accepted submission events awards every qualifying definition inside the existing submission transaction. The `(user_id, achievement_id)` primary key and conflict-safe inserts prevent duplicate unlocks. Rejected scores and conflicting idempotency requests cannot award anything; accepted non-improvements are evaluated too. The existing submission function, rate limits and response shape are unchanged.

Registration locks the board against concurrent submissions and backfills from accepted existing personal bests. Backfills persist `historical=true` and the retained best's timestamp. That timestamp is the best record's time, not necessarily the first historical threshold crossing; full historical runs are not retained. Historical awards never emit new-unlock notifications. Deleting an Auth user deletes their unlocks; configuration deletion is restricted while unlocks reference it. Each installation is isolated in its own Supabase project.

These guarantees establish consistency with accepted leaderboard results, not proof of honest gameplay. Existing range checks/rate limits do not prevent plausible fabricated client scores.

## Limits and extension points

Only descending `score_threshold` conditions are supported today. Ascending times, cumulative totals, manual/client claims, seasons and Cloud Saves are not implemented. Additional trusted evaluators can write the same permanent unlock table, with additive condition-schema migrations; retrieval and renderers need no condition-specific rewrite. Catalog retrieval is one indexed join and returns the complete catalog; exceptionally large catalogs would need pagination. Polling is intentionally portable and best effort, not a durable notification inbox. No hosted installation is verified by local tests.

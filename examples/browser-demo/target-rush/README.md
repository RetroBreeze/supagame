# Target Rush

A small standalone Canvas2D arcade game. Hit targets for 30 seconds, chain hits for a multiplier, then play again. No Supagame, Supabase, accounts, storage, remote assets or runtime dependencies.

## Run

From this directory, with Node.js 22.12+ (or 24+):

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. For a phone on your local network, use `npm run dev -- --host 0.0.0.0` and open your computer's LAN address. Mouse and touch use the same Pointer Events handler; right clicks are ignored. Sound starts after a user gesture and can be muted. Reduced motion preferences suppress particles and target pop-in.

```sh
npm test                # deterministic rules and coordinate mapping
npm run typecheck
npm run lint           # uses the repository's ESLint installation
npm run build
npm run preview        # serve dist/
npx playwright install chromium
npm run test:browser   # real Chromium mouse and emulated mobile touch
```

Browser tests write title, play and results screenshots to `/tmp/target-rush-*.png`. Mobile verification is Chromium touch emulation, not a physical device test. The game is deliberately independent of the parent's workspace: run commands from this directory. In an already installed Supagame checkout, the tools resolve from the parent dependencies without another install.

## Rules

Three non-overlapping targets are always available. Each hit immediately replaces its target. Targets live for 2 seconds initially, shortening linearly to 0.85 seconds near the end. Misses and expired targets reset the streak, without subtracting points.

Hits 1–5 earn 10 points each, 6–10 earn 20, 11–15 earn 30, and 16 onward earn 40. No reaction-time or random score bonuses. Every score is an integer. The visible outer arc shows lifetime; the solid outer disc is the hit area, including during its brief pop animation. The round uses a monotonic 30,000 ms deadline, including time spent in a background tab. Input at or after the deadline cannot score. Restart resets every round statistic and all visual effects. Nothing persists after a refresh.

## Supagame integration points

- **`src/game.ts`** is the DOM-free rules model. `Game` accepts an RNG and an `onRoundEnd(result)` callback. The callback runs exactly once per completed round with a frozen `RoundResult`: `{ score, hits, shots, bestCombo, expired }`. `scoreForCombo()` defines the complete deterministic scoring formula. The caller supplies monotonic milliseconds to `start`, `hit`, and `update`.
- **`src/main.ts` → `onRoundEnd()`** populates the results screen and dispatches `window` event **`targetrush:roundend`**. Subscribe here or call your integration from this function. The event's `detail.score` is the final score. Register your listener once, outside the restart path; the event carries no identity or authentication state. Keep asynchronous submission errors in your integration so they cannot interrupt gameplay.
- **`index.html` → `#results` / `#leaderboard-slot`** is the results layout. Mount your leaderboard or submission status in the empty slot; no fake entries or SDK implementation are included. `src/style.css` controls its presentation.
- **`src/renderer.ts`**, **`src/input.ts`**, and **`src/audio.ts`** handle visuals, scaled pointer coordinates and synthesized audio independently of scoring. Keep network calls out of these modules.

Example event subscription (no SDK dependency):

```ts
import type { RoundResult } from './src/game';

window.addEventListener('targetrush:roundend', (event) => {
  const { score } = (event as CustomEvent<Readonly<RoundResult>>).detail;
  // Hand score to your own authenticated submission flow here.
  console.log('Completed round:', score);
});
```

Client-side scores are editable by players; this game supplies no anti-cheat or server validation. Authentication, idempotency, validation, submissions and leaderboard reads belong to your future integration.

# Account linking verification — 10 November 2026

Runtime: Node **24.22.2** (official Linux x64 archive checked against published SHA-256).
All commands ran locally. No hosted Supabase or Google configuration/accounts were changed.

| Command | Result |
| --- | --- |
| `pnpm test` | PASS: 28 files, 414 unit/CLI/SDK tests |
| `pnpm test:db` | PASS: 10 SQL files, 767 assertions, then 20 concurrency tests |
| `pnpm test:cli:db` | PASS: 28 tests |
| `pnpm test:edge` | PASS: 83 tests |
| `pnpm test:edge:integration` | PASS: 1 suite, 13 steps |
| `pnpm test:sdk:integration` | PASS: 11 tests, including real local Auth/RLS JSON+binary transfer |
| `pnpm test:packages` | PASS: tarballs installed outside the repository; browser bundle and type checks |
| `pnpm test:e2e` | PASS: 11 tests, packaged CLI/SDK, local Supabase and Chromium |
| `pnpm typecheck` | PASS: workspace TypeScript and Deno Edge checks |
| `pnpm lint` | PASS: ESLint and Deno lint/format |
| `pnpm contracts:check` | PASS: OpenAPI generation and SDK validators unchanged |
| `pnpm build` | PASS: packages and browser example |
| Vaccoin `npm test` | PASS: 19 files, 128 tests in the working tree |
| Vaccoin `npm run build` | PASS; Vite retains its large-chunk warning |
| Vaccoin isolated staged commit | PASS: 118 tests and production build, excluding pre-existing user edits |
| `scripts/accounts-browser-test.mjs` | PASS: desktop and touch/mobile portrait account controls |
| `scripts/accounts-oauth-browser-test.mjs` | PASS: full mocked redirects for linking, Keep Cloud, Keep Guest and merge |
| Existing gameplay browser script | PASS on isolated rerun; first concurrent run timed out during movement |
| Existing live/achievements/Workshop browser scripts | PASS, including mobile, offline/reconnect and cosmetics |

Vaccoin browser scripts ran against the task-owned Vite server on port 5174. The existing
server on port 5173 was left alone. Existing hardcoded browser scripts were run from
temporary adjacent copies with only the port changed; the copies were removed afterwards.
New scripts accept `ACCOUNTS_TEST_ORIGIN`. Every backend HTTP/WebSocket was intercepted
for Vaccoin browser tests. Supagame integration/E2E used only the dedicated local fixture.

Auth flows use mocked Google responses. Local integration uses real synthetic Supabase
sessions and real save HTTP/RLS/storage operations, with a seeded verified callback
receipt. **No real Google OAuth round trip was performed.** Follow [accounts.md](accounts.md)
to configure Google and test disposable accounts before relying on hosted recovery.

Private package versions: `@supagame/contracts`, `@supagame/sdk-ts`, `@supagame/cli` **0.1.3**.
Fresh tarballs are in `artifacts/` (gitignored). Vaccoin's lockfile records their integrity;
installed auth/transition/save/CLI code was compared with build output. No package was published.

# Live Leaderboards verification — 10 November 2026

Local synthetic data only; no hosted scores, migrations or settings were changed.
Supagame final checks used Node 24.22.2 and pnpm 12.18.0. The system Node 26 and
shell-only pnpm launcher initially prevented subprocess packaging; isolated tools
in `/tmp/supagame-live-tools` resolved this without repository workarounds.

| Command | Result |
| --- | --- |
| `pnpm test` | 292 tests passed |
| `pnpm test:edge` | 80 tests passed |
| `pnpm test:db` | 709 SQL assertions and 18 concurrency tests passed |
| `pnpm test:cli:db` | 18 tests passed, including live catalog/policy drift |
| `pnpm test:edge:integration` | Passed, 12 local HTTP/Auth/RLS steps |
| `pnpm test:sdk:integration` | 8 tests passed, including real private WebSocket delivery |
| `pnpm test:e2e` | 9 tests passed, including installed-tarball browser consumer |
| `pnpm test:packages` | Isolated tarball installation/typecheck/browser bundle passed |
| `pnpm typecheck` | Passed, including Deno Edge checks |
| `pnpm lint` | Passed, including Edge lint/format |
| `pnpm build` | Passed |
| `pnpm contracts:check` | Passed |

Vaccoin: `npm test` passed 92 tests; `npm run build` passed (existing large-bundle
warning); `npm run test:browser` passed with no browser errors. The additional
`npm run test:browser:live` passed against the locally running Vite server with
`VACCOIN_TEST_URL=http://127.0.0.1:5174`. It intercepts HTTP and WebSockets, checks
initial top-ten loading, Broadcast updates, rank notices and reconnect refresh,
and captures desktop/mobile rolling-display screenshots. Screenshots were
visually inspected; the unsupported hash glyph was replaced with numbered ranks.

Vaccoin uses the rebuilt local SDK and CLI tarballs. Its installed CLI dry run
reports one new `20261110000100_live_leaderboards.sql` migration and one manifest
update, with all previous migration/function/config files unchanged. Pre-existing
untracked installation files remain uncommitted. Hosted deployment instructions
are in Vaccoin's `docs/live-leaderboards.md`.

Limits: private channels require an authenticated session; one subscription per
board per supplied Supabase client; best-effort Broadcast delivery; two separate
HTTP snapshot reads; no polling or durable/offline notifications. Hosted settings
and production WebSocket delivery are intentionally left for an explicitly
approved deployment and real gameplay smoke check. No required local suite
remains blocked.

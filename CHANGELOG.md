# Changelog

## 0.1.0

- npm packages: `@retrobreeze/supagame-cli`, `@retrobreeze/supagame-sdk` and `@retrobreeze/supagame-contracts`.
- Guided setup, leaderboard and achievement creation, public connection exports and JSON automation.
- Anonymous player identities, display names, best-score leaderboards and optional live updates.
- Score-based achievements, JSON and binary cloud saves, account linking and recovery.
- Optional administration: leaderboard resets, score moderation, player restrictions and audit history.
- Local Admin Dashboard with project selection, launch-code authentication, previews and confirmations.
- Hosted operator verification uses the operator transport while ordinary queries remain read-only.
- Node.js 24/26 and Supabase CLI 3.0.0/3.1.0 support, with isolated package and local integration tests.
- Standalone Target Rush example and npm-based setup guides.
- Generation-protected Cloud Saves with bounded metadata, a finite replay guarantee, independent upload/abort throttling and deleted-account authorization; coordinate matching database, Edge and SDK upgrades.
- Indexed leaderboard pagination with exact ranks and documented scaling limits.
- Official portable `supagame` agent skill for TypeScript and engine-independent HTTP integrations, diagnostics and consent-based deployment.
- npm 12.2.0 workspace tooling and reproducible package-lock installs; isolated npm-distributed Deno for Edge validation. Contributor commands require Node 24.15+ (24.x) or 26.x.

Installed module versions have their own upgrade history and need not match the npm version.

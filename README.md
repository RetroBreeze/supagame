# Supagame

Ready-to-use game features, backed by your own Supabase project.

Add player identities, leaderboards, achievements and cloud saves to your game.
Supagame handles backend setup through a guided CLI. Connect any engine through
the HTTP API, or use the TypeScript SDK for JavaScript and TypeScript games.

## Quick start

You need a Supabase project and Node.js **24 or 26**. Run these commands in your game project:

```sh
npm install -D @retrobreeze/supagame-cli supabase@3.1.0
npx supagame init
npx supagame leaderboard create arcade
npx supagame deploy --project-ref YOUR_PROJECT_REF
npx supagame connection
```

In `init`, choose your project and **Leaderboards**. For `arcade`, choose points
and descending order to keep each player's highest score. Deployment shows the
changes and asks for confirmation before applying them.

**[Follow the quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart)**
for setup and connecting your game. Hosted setup does not require Docker.

## Features

- **Players:** anonymous sign-in, display names and account linking.
- **Leaderboards:** personal bests, tied ranks and optional live updates.
- **Achievements:** permanent unlocks based on leaderboard scores.
- **Cloud saves:** player-owned JSON and binary saves with revision handling.
- **Admin tools:** inspect players, moderate scores and manage boards through the CLI or local dashboard.

Your data stays in your Supabase project. Scores are validated and rate-limited;
these checks do not prove that a submitted score came from honest gameplay.

## Documentation

[Guides](https://github.com/RetroBreeze/supagame/wiki) ·
[CLI](https://github.com/RetroBreeze/supagame/wiki/CLI) ·
[HTTP API](https://github.com/RetroBreeze/supagame/wiki/API) ·
[TypeScript SDK](packages/sdk-ts/README.md) ·
[Troubleshooting](https://github.com/RetroBreeze/supagame/wiki/Troubleshooting)

Try [Target Rush](examples/target-rush/README.md), a small game demonstrating the
leaderboard integration. See [contributor documentation](docs/README.md) for source
layout, development and historical records.

## License

[MIT](LICENSE)

Cloud Saves writers must retain generation context with durable operations. The
[protocol and retention guide](docs/guides/cloud-save-protocol.md) defines the
finite replay guarantee, upload limits and explicit offline reconciliation.

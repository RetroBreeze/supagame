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
- **Cloud saves:** player-owned JSON and binary saves with generation/revision protection and explicit offline reconciliation.
- **Admin tools:** inspect players, moderate scores and manage boards through the CLI or local dashboard.

Your data stays in your Supabase project. Scores are validated and rate-limited;
these checks do not prove that a submitted score came from honest gameplay.

Cloud Saves durable writes retain generation context and have a finite replay
guarantee. See the [protocol and retention guide](docs/guides/cloud-save-protocol.md)
before implementing offline queues or upgrading older writers.

## Documentation

[Guides](https://github.com/RetroBreeze/supagame/wiki) ·
[CLI](https://github.com/RetroBreeze/supagame/wiki/CLI) ·
[HTTP API](https://github.com/RetroBreeze/supagame/wiki/API) ·
[TypeScript SDK](packages/sdk-ts/README.md) ·
[Troubleshooting](https://github.com/RetroBreeze/supagame/wiki/Troubleshooting)

Try [Target Rush](examples/target-rush/README.md), a small game demonstrating the
leaderboard integration. See [contributor documentation](docs/README.md) for source
layout, development and historical records.

## AI coding agent skill

The official [supagame skill](.agents/skills/supagame/SKILL.md) helps coding agents
integrate leaderboards, achievements, live updates and Cloud Saves, diagnose an
installation and plan upgrades. It covers the TypeScript SDK and engine-independent
HTTP integration, with explicit authorization before hosted deployment.

From a trusted checkout of the Supagame revision matching your installation, copy
the **entire** skill directory into your game repository (POSIX shell example):

```sh
mkdir -p /path/to/your-game/.agents/skills
cp -R /path/to/supagame/.agents/skills/supagame /path/to/your-game/.agents/skills/
```

Check for an existing destination first; review updates rather than overwriting a
customized copy. [Codex discovers project skills](https://developers.openai.com/codex/skills)
in `.agents/skills`; other
[Agent Skills-compatible agents](https://agentskills.io) can use the same folder
through their supported skill directory or installer. Follow that agent's reload
instructions and verify that `supagame` appears in its available skills. Copying it
only into the Supagame source repository does not install it into other games.

Ask “Use the supagame skill to add leaderboards to my Unity game” or, in Codex,
“$supagame add Cloud Saves to this project.” The authoritative source is
`.agents/skills/supagame/` in this repository. The skill is distributed from source;
installing the npm CLI/SDK does not install or activate it in an agent.

## License

[MIT](LICENSE)

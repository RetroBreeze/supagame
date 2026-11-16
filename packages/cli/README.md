# @retrobreeze/supagame-cli

Set up and manage game features in your own Supabase project.

## Install and start

Use Node.js **24 or 26**. From your game project:

```sh
npm install -D @retrobreeze/supagame-cli supabase@3.1.0
npx supagame init
npx supagame leaderboard create arcade
npx supagame deploy --project-ref YOUR_PROJECT_REF
npx supagame connection
```

The guided setup walks through Supabase login, project selection and features.
Choose Leaderboards, then create a points/descending board to keep each player's
highest score. Deployment previews the destination and asks for confirmation.
Supabase CLI **3.0.0 and 3.1.0** are supported. Hosted deployment needs no Docker.

See the [quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart) for the
full walkthrough and [CLI reference](https://github.com/RetroBreeze/supagame/wiki/CLI)
for commands, automation and configuration.

Games connect through the [HTTP API](https://github.com/RetroBreeze/supagame/wiki/API)
or [TypeScript SDK](https://github.com/RetroBreeze/supagame/blob/main/packages/sdk-ts/README.md).
The CLI is only needed for backend setup and maintenance.

[MIT license](https://github.com/RetroBreeze/supagame/blob/main/LICENSE)

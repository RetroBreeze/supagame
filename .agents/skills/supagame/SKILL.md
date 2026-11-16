---
name: supagame
description: Integrate Supagame game backends into a developer's own Supabase project. Use when setting up Supagame, adding leaderboards, score-based achievements, live leaderboards or Cloud Saves, integrating Supabase Auth with a game, diagnosing a Supagame deployment, or upgrading an installation in browser, Node.js, Unity, Godot, Unreal or custom-engine projects.
license: MIT
---

# Supagame integration

Supagame provisions a backend in the developer's Supabase project. The CLI is
operator tooling; games use the versioned HTTP API. The official runtime SDK is
TypeScript. There are **no official Unity, Godot, Unreal, C# or GDScript SDKs**.
Use HTTP in those environments; retain their build, configuration and lifecycle
conventions. Node tooling for provisioning does not require a JavaScript game.

These instructions target public packages **0.1.0**, HTTP **v1**, module templates
**0.1.5** (distinct version numbers). Inspect installed package versions and CLI
help before adapting examples. Prefer matching implementation/OpenAPI over older
Wiki snippets, especially Cloud Saves examples without generation context.

## Workflow

1. **Inspect.** Check source-control changes, engine/version, project root,
   existing Supabase client/Auth/session persistence, environment configuration,
   leaderboard/save code, `supabase/config.toml`, link metadata and
   `supagame.config.json` modules. Inspect configuration names without printing
   secrets. Preserve functioning configuration and user edits. Resolve conflicting
   project references before writing; ask for missing destination or game rules.
2. **Plan.** Explain the smallest required modules, additive SQL/schema changes,
   Auth requirements, client path, exact browser origins (if applicable), and
   eventual hosted deployment. All selectable modules currently include Core and
   Leaderboards dependencies. Do not add Admin for ordinary player features.
3. **Configure.** Read [CLI setup and deployment](references/cli.md). Preview
   local changes, stage only requested features, and review generated migrations.
   Use explicit arguments without a TTY; do not assume every command prompts.
4. **Integrate.** Read [TypeScript integration](references/typescript.md) for JS/TS,
   or [engine-independent HTTP](references/http.md) for native/custom clients.
   Reuse existing Auth sessions; only create an anonymous player when no session
   exists. A refresh failure must not silently create a replacement identity.
   For any save work, also read [Cloud Saves](references/cloud-saves.md).
5. **Verify.** Follow [diagnostics](references/diagnostics.md). Report separately
   local file checks, database checks, hosted function inspection, runtime HTTP,
   browser CORS and actual Realtime delivery. Exercise the game lifecycle,
   failure handling and disposal. A healthy doctor result is not runtime proof.
6. **Deploy only with consent.** Show the actual `deploy --dry-run` preview with
   exact destination and **all** pending migrations before requesting authorization
   for those hosted changes. Integration requests are not deployment consent.
   Never add `--allow-remote` merely to bypass a prompt. Preserve deployment
   journals and investigate uncertain outcomes before retrying.

## Invariants

- Clients contain only public project connection information and the player's
  session, never service-role/secret keys, database passwords or operator tokens.
  Publishable keys rely on server Auth, grants and RLS; they are not player JWTs.
- The server derives identity. Do not insert directly into protected tables or
  bypass RLS. Score bounds/rate limits cannot prove honest gameplay.
- Scores are JSON safe integers, even in engines with wider integers. Keep one
  best per board; use backend ranks and opaque pagination cursors.
- Origins match exactly: `localhost` and `127.0.0.1` differ. Preserve unrelated
  Supabase settings, secrets, functions and Realtime policies.
- Save generations and finite replay guarantees are part of the write protocol.
  Preserve offline payloads; conflict reconciliation is an explicit new intent.
- Raw diagnostic logs may contain credentials; review/redact before sharing.

Finish with changed files, checks and their limits, deployment status, and any
remaining user decisions. Do not claim unavailable native SDKs, arbitrary
achievement rules, multiplayer, friends, seasons or replay-based anti-cheat.

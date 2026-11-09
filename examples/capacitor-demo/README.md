# Minimal Supagame consumer

A small browser application, compatible with a Capacitor WebView build. It uses
`@supagame/sdk-ts` for profile, score and leaderboard operations and the caller-owned
Supabase client for authentication. It is not a game and does not touch Vaccoin,
Toy Tanks or any other project.

Follow [quickstart](../../docs/quickstart.md) to stage the backend and create:

- `level-1`: time, ascending, 0–1000000 (this demo treats values as milliseconds).
- `arcade`: points, descending, 0–1000000.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
cp examples/capacitor-demo/.env.example examples/capacitor-demo/.env.local
# Set the local URL and modern publishable key; no privileged credentials.
pnpm --filter @supagame/capacitor-demo dev --port 5173 --strictPort
```

Allow `http://127.0.0.1:5173` in `SG_ALLOWED_ORIGINS`. Open that address, choose a
display name, submit scores to either board, and inspect the top ten/personal best.
Names are rendered using `textContent`; no user-provided HTML is inserted.
Configuration errors and typed SDK/API errors are displayed without logging tokens.

The page reuses an existing anonymous or permanent session. It persists identity
through the Supabase client's normal browser storage. It keeps a failed submission
key in memory for retry, but does not implement an offline queue; reloads lose that
pending key. Production games should persist uncertain attempts if necessary.
Do not clear storage or replace a failed session merely to hide an error.

`pnpm test:e2e` copies this example outside the repository, builds it against the
SDK installed from a tarball, then drives real Chromium against a fresh local
Supabase backend. It verifies browser sign-in, profile, both boards and reload
persistence, and scans the bundle for privileged local credentials/build canaries.

## Capacitor

`capacitor.config.json` declares `webDir: "dist"`. `pnpm --filter
@supagame/capacitor-demo build` produces web assets suitable for an existing
Capacitor project. Add/sync native platforms using your application's chosen,
pinned Capacitor toolchain; no generated Android/iOS project or native dependency
is included here. See the [official installation guide](https://capacitorjs.com/docs/getting-started).

Configure the exact origins used by your WebView (for example
`capacitor://localhost` or `http://localhost`) in the backend allowlist. Physical
devices cannot reach your workstation through their own `127.0.0.1`; use an
appropriately secured reachable backend. Hosted HTTPS, native deep links, native
storage adapters and physical-device builds have **not** been verified here.
The automated consumer is Chromium, not an Android/iOS emulator.

OAuth/email linking belongs to the application's Auth flow. See
[identity and linking](../../docs/security.md#anonymous-identity-and-linking).

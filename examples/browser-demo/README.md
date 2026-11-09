# Minimal Supagame browser demo

A small standalone browser application. It uses
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
cp examples/browser-demo/.env.example examples/browser-demo/.env.local
# Set the local URL and modern publishable key; no privileged credentials.
pnpm --filter @supagame/browser-demo dev --port 5173 --strictPort
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

## Browser build

`pnpm --filter @supagame/browser-demo build` produces static assets in `dist`.
Use `pnpm --filter @supagame/browser-demo preview --port 5173 --strictPort` to
preview the build locally with the same allowed origin. Production hosting must
serve HTTPS and configure the backend's exact origin allowlist.

The example uses standard browser APIs and requires no native platform or mobile
toolchain. Chromium is the automated consumer; other browsers and hosted HTTPS
configuration have not been independently verified here.

OAuth/email linking belongs to the application's Auth flow. See
[identity and linking](../../docs/security.md#anonymous-identity-and-linking).

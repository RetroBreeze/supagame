# Admin Dashboard v1 design

Scope authorized by the user's end-to-end implementation request. Implementation decisions below follow that specification; no separate design approval conversation was requested.

## Existing architecture and decisions

`commands/admin.ts` resolves a manifest/TOML/link, creates an isolated Supabase CLI workdir and uses `DoctorInspector` for read-only SQL. `lib/admin.ts` builds narrow inspection and `sg_private.admin_apply` calls. The database owns authorization, revisions, generations, restrictions, audit and idempotency. Package assets are copied by `packages/cli/scripts/copy-assets.ts`.

Extract `lib/admin-service.ts` for connection resolution, target revalidation, reads and execution, shared by CLI and dashboard. Keep the Supabase CLI subprocess adapter for operator authentication (no new credential system); do not spawn the Supagame CLI for dashboard actions. No migrations, Edge routes or SDK changes.

A Node HTTP server binds 127.0.0.1 exclusively. Each session targets one immutable root, local project_id, port, manifest reference and module set. Remote requires --remote; dashboard resolves the manifest reference without requiring another CLI argument. Startup performs read-only target-envelope, security and operator-role checks. Before mutation re-read configuration and reject drift; fixed connection parameters never come from HTTP input.

## Browser boundary

Print a 256-bit launch code separately from the URL. A public static login page reveals no project data. Operator pastes the code; an Origin-checked POST exchanges it for an in-memory session bearer and independent CSRF token. Both remain in browser memory (no cookies, local/session storage or URL credentials). Reload requires authentication again. All API calls are JSON POST with exact Origin, Host (localhost or 127.0.0.1 and selected port), bearer and CSRF checks. No CORS. Reject cross-site Fetch Metadata, unexpected routes/fields/methods, large/slow requests and forwarded-host headers. Strict CSP, no inline script/style, no framing/referrers/cache. Session count, API concurrency, body size, query duration and preview count are bounded. Shutdown invalidates secrets and aborts owned subprocesses.

## Operations and UI

Bundled vanilla TypeScript/CSS/HTML, compiled with existing esbuild. Dark developer-tool layout with persistent project/environment header, accessible navigation, overview, boards, submissions, player lookup and audit. Use DOM textContent for all untrusted text, bounded tables, explicit loading/empty/error states. Database counts are real; audit attribution is the database role.

Missing read capability: existing inspection gives 100 recent submissions without user IDs in board inspection. Add fixed read-only SQL over existing private events for board-scoped 50-row keyset pages, optional exact player/score IDs and generation. Add bounded profile listing and overview counts. Audit remains a filtered view of the latest 100 rows. No new database execution surface or unbounded rows.

Preview generates server-owned UUID, action, target, original revision, current state and 10-minute expiry. Execute accepts only preview ID, reason and confirmation (board ID for reset; target for other actions). Freeze the reason on first attempt; retain the same UUID and original revision for retries, including unknown outcomes. Database idempotency remains authoritative. Successful duplicate calls return a marked cached result; no automatic retry or false success. Stale revisions require a new preview. Expiry never silently creates a replacement operation.

## Verification

Unit/security tests use injected operator transport and real HTTP loopback sockets. Browser tests use Playwright and synthetic data. Existing isolated packaged Supabase E2E exercises real dashboard operations. Fresh tarball starts without source dependencies. Node 24 baseline; no hosted requests or mutations during tests.

# Admin Dashboard implementation plan

**Goal:** Deliver the user's CLI-hosted, single-project Admin interface.
**Spec:** ../specs/2026-11-11-admin-dashboard-design.md
**Execution:** Inline; repository prohibits subagents. Test first, then implement and verify each boundary.

- [x] `packages/cli/src/lib/admin-service.ts`: `resolveAdminTarget`, `openAdminService`, `AdminService.query/execute/revalidate/close`; preserve existing CLI behavior while sharing transport. Test config drift, mode selection, authentication and sanitized failures in `tests/cli/admin-dashboard.test.ts`.
- [x] `packages/cli/src/dashboard/operations.ts`: validated read inputs, fixed bounded SQL, server-owned preview operations and exact retry payloads; no generic SQL route. Test every existing action and stale/unknown outcomes.
- [x] `packages/cli/src/dashboard/server.ts`: `startDashboard(service,{port})` returns address, launch code and async close; secure HTTP envelope and lifecycle. Test real requests including Host, Origin, auth, CSRF, body bounds, methods, unknown fields and port conflict.
- [x] `packages/cli/src/commands/admin-dashboard.ts` and `src/cli.ts`: register flags, verify operator/target, print address and SSH instructions, handle signals and abort subprocesses. Keep --remote explicit.
- [x] `packages/cli/dashboard/{index.html,app.ts,style.css}`: responsive accessible five-section interface, memory-only auth, read filters/pagination, preview dialog, reason and typed confirmation, immutable retry. `scripts/copy-assets.ts` bundles into `dist/dashboard`. Test UI using Playwright in `tests/e2e/admin-dashboard.test.ts`.
- [x] Extend `tests/e2e/install-and-play.test.ts` and package tests for installed dashboard, real local SQL actions, audit and idempotency. Run Node 24 regressions, typecheck, lint, build and fresh tarballs.
- [x] Write `docs/admin-dashboard.md`, update `docs/admin.md`, record verification and limitations, commit task-only changes. Never publish, push, deploy or mutate Vaccoin.

## Execution record

Completed inline under repository instructions. Test-first failures established missing service/server boundaries, ambiguous config handling and incomplete security response rejection. No migrations or new runtime dependencies were needed. CLI package is 0.1.5; database modules stay 0.1.4. Fresh package tests use actual local operator authentication; HTTP security tests use real loopback sockets and controlled backend data. See `docs/admin-dashboard-verification.md` for exact results and limits.

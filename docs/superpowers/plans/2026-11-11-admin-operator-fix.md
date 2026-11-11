# Dashboard operator authorization fix

**Goal:** Fix the reported CLI 0.1.5 hosted startup failure without changing Admin permissions.
**Spec:** User bug report and `../specs/2026-11-11-admin-dashboard-design.md`.
**Architecture:** Keep shared project resolution and credentials. Run only the fixed operator capability SELECT through the same Supabase CLI transport as Admin mutations; retain read-only transport for ordinary reads and doctor. No SQL migration or browser changes.
**Execution:** Inline, test first, one local commit after verification; no agents, publication, deployment or hosted mutations.

## Evidence

On the reported project, the same isolated workdir and credentials yield
`supabase_read_only_user`, execute=false through `--read-only`, but `postgres`,
execute=true through the normal query transport. Local read-only queries use
`postgres`, explaining why local E2E did not catch this. Both source and installed
0.1.5 resolve Vaccoin's exact root and reference correctly.

## Single fix task

- [x] Add failing hosted-role regression in `tests/cli/admin-dashboard.test.ts`:
  read-only transport denies execution while operator transport permits it.
  Verify pinned target, unchanged ordinary reads, malformed/denied results and
  sanitized transport failure. Exercise the actual SQL with local PostgreSQL.
- [x] In `packages/cli/src/lib/admin-service.ts`, move the fixed permission
  SELECT to operator transport, retain both checks and require exactly one boolean
  result. Distinguish unavailable verification from denied permissions without
  exposing subprocess output. Do not add a generic privileged read interface.
- [x] Increment `packages/cli/package.json` to 0.1.6 and update package expectations.
  Add a packaged hosted-transport regression using a synthetic Supabase process;
  existing installed local E2E continues to exercise real database operations.
- [x] Document the transport distinction and updated install commands in
  `docs/admin-dashboard.md`; record fresh evidence in its verification document.
- [x] Run Node 24 unit/security, database/CLI integration, Edge and SDK integration,
  E2E, package, typecheck, lint, contracts and build checks. Build a fresh 0.1.6
  tarball, check hosted startup using only reads, review diff and commit locally.

## Review focus

Read-only transport must never authorize Admin; missing execution privilege must
still deny; malformed JSON must fail closed; subprocess diagnostics must not leak;
target drift and packaged execution must retain the same immutable project.

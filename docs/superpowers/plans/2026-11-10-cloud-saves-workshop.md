# Cloud Saves and Vacuum Workshop Implementation Plan

> Execute inline with executing-plans and test-driven-development. The user explicitly authorized the complete cross-repository feature, local commits and autonomous design choices; no agents or hosted mutations.

**Goal:** Ship project-owned Cloud Saves and a cosmetic Vaccoin Workshop without compromising existing progress or services.

**Architecture:** Extend the shared Edge HTTP API and CLI inventory. PostgreSQL owns JSON, revisioned slot metadata, tombstones, idempotency receipts and binary reservations. Private Storage objects are immutable: prepare, upload, commit; retired/aborted objects are garbage collected through Storage APIs. An optional IndexedDB adapter stores player-scoped snapshots and pending writes. Vaccoin uses durable operation IDs and explicit semantic replay for conflict recovery; generic JSON is never merged.

**Tech stack:** Existing TypeScript, SQL, Supabase CLI 3, Deno, Vitest, pgTAP, Playwright, Canvas2D and Three.js. Verify on Node 24.

**Spec:** User's Cloud Saves / Vacuum Workshop request, extending the approved v0.1 design. Work in the requested repositories and preserve the captured pre-existing edits.

## Constraints and decisions

- No hosted mutation, publishing, pushing, credentials in client/logs, or gameplay balance changes.
- Revision 0 means create only. Loaded revisions are required for replacement/deletion. Deletion retains revision tombstones to prevent stale resurrection.
- Default limits: 10 active slots, 1 MiB JSON, 50 MiB binary, 100 MiB total/player, 20 pending binary reservations. Configuration is staged by CLI as additive SQL.
- JSON stays in PostgreSQL. Binary uses immutable owner/operation paths, reservation-bound policies, metadata commit after object verification, and explicit recoverable garbage collection. Global Storage service limits may impose a lower ceiling.
- Browser adapter persists before network IO, isolates by project namespace + player ID, preserves conflicting local data, and never treats auth/API/server errors as offline success.
- Workshop profile is schema 1, slot `vacuum-workshop`. Completed-run and purchase operation IDs are retained to make replay idempotent. No leaderboard/achievement records or reconstructed earnings.
- Existing uncommitted Vaccoin work is preserved and excluded from task commits.

## Review focus

Account switches while requests are pending; startup before remote hydration; response lost after commit; simultaneous purchase/run replay; failed upload/commit/cleanup and restrictive policy interaction with unrelated buckets.

## Execution

- [x] 1. Database/contract: failing lifecycle, quota, revision, replay, concurrency and RLS tests; implement additive Cloud Saves SQL and shared DTOs; run SQL/contract checks.
- [x] 2. API/SDK: failing authenticated HTTP, JSON/binary and durable offline tests; implement routes, typed errors, saves API and IndexedDB adapter; verify conflicts retain both copies and account isolation.
- [x] 3. CLI: failing installer/configuration/upgrade/doctor tests; inventory 0.1.2 with immutable prior assets; preview Storage provisioning via migrations; inspect bucket/policies with provenance.
- [x] 4. Vaccoin: failing progression/replay/purchase/restore tests; implement durable profile journal, hydration and conflict recovery; Canvas2D workshop and six material palettes; preserve score/achievement flows.
- [x] 5. Delivery: build/pack fresh packages, verify archive contents, install in Vaccoin; run full local suites on Node 24, desktop/mobile browser checks, document SDK/architecture/deployment; review diff and make focused local commits.

## Verification ledger

Record commands/results in `docs/cloud-saves-verification.md`; do not claim unavailable checks passed.

# Achievements implementation plan

Goal: implement the user's Achievements specification across Supagame and Vaccoin, locally only.

Architecture: trusted score-record triggers award permanent unique player unlocks in the submission transaction. Versioned configuration migrations register definitions and backfill existing bests. Authenticated HTTP reads return definitions and player progress together. A framework-independent SDK event source and queue feed optional DOM and Vaccoin Canvas renderers. Historical reads never emit unlock events.

Constraints: preserve existing migrations, leaderboard semantics, unrelated files, hosted confirmation and anonymous identities. No privileged client writes, hosted changes, publication or pushes. Repository AGENTS forbids delegation without explicit user request; execute inline.

- [x] Database: add definitions/unlocks, constraints, RLS, trusted evaluation, backfill, retrieval; test boundaries, concurrency, isolation and rejected/replayed submissions.
- [x] Contracts/API/SDK: publish authenticated retrieval contracts, event lifecycle and reusable notification controller; test hydration, retry deduplication and cleanup.
- [x] CLI: module inventory/dependencies, configuration registration, staging/upgrades, deployment and doctor; test repeat installs and dry runs.
- [x] Optional browser renderer and documentation with copyable configuration/API examples.
- [x] Vaccoin: configure six single-run thresholds on existing `vaccoin` board, Canvas notifications and title achievements list; test existing game flows.
- [x] Run full local verification, rebuild and inspect package artifacts, consume locally, review changes and commit verified work.

Review focus: pre-existing personal bests; lost submission responses; cross-user changes during async reads; backfill notification suppression; preserving old installation templates during upgrade.

Verification evidence: docs/achievements-verification.md. Inline review; no hosted changes. Existing unrelated files preserved.

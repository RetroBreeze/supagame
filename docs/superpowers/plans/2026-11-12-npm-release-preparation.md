# npm 0.1.0 Release Preparation Plan

> Execute inline with test-driven-development and verification-before-completion.
> No delegation, publication, hosted mutations or changes to other games.

**Goal:** Prepare the three public npm packages requested on 2026-11-12,
retaining `private: true` until a separately authorized publication.

**Architecture:** Preserve SDK/CLI behavior and database/module versions. Rename
npm identities only. Extend existing clean-source packaging tests with a read-only
loopback registry to exercise automatic transitive dependency resolution.

**Spec:** User's Node.js Compatibility & npm Release Preparation request;
existing product design and v0.1 plan remain the architectural references.

## Constraints and decisions

- Proposed names: `@retrobreeze/supagame-{contracts,sdk,cli}`, all `0.1.0`.
- Executable remains `supagame`; root and packages remain private.
- Engines become `^24.0.0 || ^26.0.0` only after both runtimes pass.
- Preserve existing Wiki migration edits/deletions and regression tests.
- Ship npm quickstart in `packages/cli/README.md`; do not restore deleted guides.
- Existing module schema version `0.1.4` is independent of npm versions.
- User explicitly authorized implementation and a focused final commit; work in
  place, stage only task changes, no new approval or subagent workflow.

## Task: Prepare and verify release artifacts

- [x] Extend archive tests for proposed names, metadata, README/license, all
  declared entries, dependency versions, isolated transitive resolution.
- [x] Observe failure before changing manifests.
- [x] Rename references and set package metadata; retain build/validation hooks.
- [x] Run clean-source package tests, including stale-output and noEmit rejection.
- [x] Add Node 24/26 matrix to both existing non-publishing CI jobs and manual
  release-validation trigger. No publish job or OIDC write permission yet.
- [x] Write complete CLI/SDK quickstart and manual release/OIDC instructions.
- [x] Run build, typecheck, lint, contracts, unit, Edge, database, CLI database,
  Edge integration, SDK integration, packaging and E2E on Node 24 and 26.
- [x] Inspect Vaccoin read-only; document necessary consumer import rename.
- [x] Review diffs and safeguards, record results, commit only release changes.

## Review focus

- SDK install must resolve contracts without a separately supplied contracts tarball.
- Real tarballs must carry all exports, declarations, runtime assets and licensing.
- Clean-source packing must rebuild and reject absent emitted artifacts.
- Node runtime changes must not weaken account, offline, live or SQL tests.
- Existing user documentation changes must remain outside the release commit.

## Execution notes

- Both full matrices passed; see `RELEASING.md` for exact commands and counts.
- Node 26 found a pnpm shim ENOEXEC issue. Added a failing literal-argv regression,
  then fixed the test launcher with an explicit static POSIX shell invocation.
- Packaging overlays now include examples because their renamed workspace
  dependency must agree with the frozen lockfile in a source clone.
- No production behavior, SQL or existing account/offline/live tests changed.
- Review performed inline; user instructions prohibit subagent review.
- Pre-existing documentation migration stays unstaged; release edits to overlapping
  README files are staged independently from the preserved Wiki-link edits.

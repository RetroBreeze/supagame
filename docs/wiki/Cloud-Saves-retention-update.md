# Wiki synchronization review — 2026-11-16

Source reviewed: main `998b2c94408a2f8adf5b71f08c01d929b1a9a936`.
Wiki base: `01817e99a67a1517166757da33ef1a10e7227e28`.
Published Wiki commit: `0eb4aa25987d98070d506b334542820db6fcb369`.

The 30-page update was published over SSH after the initial HTTPS push failed
because no HTTPS credentials were available. The remote `master` reference was
verified as `0eb4aa25987d98070d506b334542820db6fcb369` using `git ls-remote`.
The [agent skill guide](https://github.com/RetroBreeze/supagame/wiki/Agent-Skill)
and updated feature guides are now published.

The [complete zero-context patch](pre-release-remediation.patch) is retained as
an archive of the published changes and supersedes the older remediation draft.
It updates Cloud Saves generation context, finite replay, durable JSON/binary/
recovery examples, offline reconciliation, limits and deleted-user authorization;
aligns API, setup, deployment, upgrades, security, troubleshooting and contributor
tooling; adds the Agent Skill guide and navigation; and labels historical
verification records without rewriting results. Do not reapply it to the current Wiki.

## Verification

- Strict TypeScript compilation of revised Cloud Saves and recovery snippets
  against freshly packed CLI/SDK/contracts; application helpers declared explicitly.
- All 281 repository/Wiki page and file link targets resolved across 45 checked
  documents. The patch applies cleanly to the exact base and reproduces all
  31 Wiki pages byte-for-byte (30 changed, one unchanged).
- CLI help reviewed; packaged skill examples exercised locally without a TTY.
- Both skill validators, 3 skill consumer/transport checks, 655 unit tests, 84 Edge
  tests, typecheck, lint, contract checks and `git diff --check` passed.
- No hosted Supabase writes or package publication. Full release matrix, database
  integration and browser/device acceptance were not repeated for this docs review.

See the [skill validation record](../verification/AGENT-SKILL.md) for scope and
limits. npm metadata, lockfiles and runtime implementation were preserved.

## Publication

Published with:

```sh
git push git@github.com:RetroBreeze/supagame.wiki.git master
git ls-remote git@github.com:RetroBreeze/supagame.wiki.git refs/heads/master
```

Only the Wiki was pushed. Main-repository commits remain local; no npm packages,
tags or hosted Supabase resources were published or changed.

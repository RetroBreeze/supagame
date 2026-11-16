# Wiki synchronization review — 2026-11-16

Source reviewed: main `998b2c94408a2f8adf5b71f08c01d929b1a9a936`.
Wiki base: `01817e99a67a1517166757da33ef1a10e7227e28`.
Prepared Wiki commit: `0eb4aa25987d98070d506b334542820db6fcb369`.

The user requested updating all documentation, including the Wiki. The 30-page
update is committed locally but **not published**: `git push origin master`
failed because no GitHub HTTPS credentials were available; `gh auth status`
confirmed no logged-in GitHub host. Authentication is required to finish publication.

The [complete zero-context patch](pre-release-remediation.patch) supersedes the
older zero-context remediation draft. It updates Cloud Saves generation context,
finite replay, durable JSON/binary/recovery examples, offline reconciliation,
limits and deleted-user authorization; aligns API, setup, deployment, upgrades,
security, troubleshooting and contributor tooling; adds the Agent Skill guide and
navigation; and labels historical verification records without rewriting results.
The repository avoids new links to the unpublished Wiki page.

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

## Finish publication after GitHub authentication is restored

Use the existing reviewed Wiki checkout if it is still available, or apply this
patch to a fresh checkout after checking its base. From that Wiki checkout:

```sh
git rev-parse HEAD
# Expected patch base: 01817e99a67a1517166757da33ef1a10e7227e28
git apply --check --unidiff-zero /path/to/supagame/docs/wiki/pre-release-remediation.patch
git apply --unidiff-zero /path/to/supagame/docs/wiki/pre-release-remediation.patch
git diff --check
git diff --stat
git add -- '*.md'
git commit -m "docs: align guides with release candidate and agent skill"
git push origin master
```

Do not reapply the patch to the already committed checkout. If upstream changed,
review/reconcile it rather than forcing the push. Verify the remote commit after
publication and update this record. The original local commit ID will differ if
the patch is committed again. Wiki publication is separate from pushing main or
publishing npm packages.

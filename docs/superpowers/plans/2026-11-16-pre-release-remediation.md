# Pre-release remediation execution ledger

Architecture approved by the user on 2026-11-16, including generation context,
finite guaranteed replay, explicit offline reconciliation and bounded metadata.
The approval applies to the summary and the user's safeguards, not every detail
of the earlier proposal. Execute inline; no agents, hosted writes, resets or pushes.

## Tasks

- [x] Reproduce deleted identities and upload lifecycle throttling; implement additive SQL authorization and bounded rate state.
- [x] Reproduce metadata growth/stale resurrection; implement generation fencing, bounded receipts/tombstones/objects and safe cleanup.
- [x] Update HTTP contract, SDK, offline/account transitions and existing-data upgrade coverage.
- [x] Capture index and pagination baselines; implement measured additive improvements and stable plan regressions.
- [x] Update module inventories/legacy snapshot, docs and package consumption; verify all previous migration hashes.
- [x] Execute full applicable suites and Node/CLI matrix, review bypasses, commit focused changes and report GO/NO-GO.

## Verification record

Pre-existing working tree and migration hashes captured under ignored
`.superpowers/pre-release-remediation/`. Public package private flags were already
false before this task; this task will not change them.

Executed red/green regressions for deleted identities (including a confirmed
post-deletion reservation AND successful upload on the old implementation),
upload lifecycle throttling, receipt/tombstone growth, ranking work, receipt
completion ordering, direct PostgREST reads and offline generation races.

The focused tests are followed by the full verification matrix; final results
and benchmark qualifications are recorded in the accompanying verification report.
No historical migration changed. New local migrations were applied forward-only;
no database reset, hosted mutation or publication was performed.

Final verification: 76 matrix/follow-up commands exited zero, plus all five
benchmark invocations and production dependency audit. See
[the final report](../../verification/PRE-RELEASE-REMEDIATION.md) for exact results,
tradeoffs, review findings and release assessment.

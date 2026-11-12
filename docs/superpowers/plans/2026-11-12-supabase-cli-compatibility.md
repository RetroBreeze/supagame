# Supabase CLI 3.0.0 / 3.1.0 Compatibility Plan

**Goal:** Support the two verified stable CLI releases without weakening deployment
safety. The user's compatibility request is the implementation specification;
existing product design and v0.1 plan remain architectural references.

**Approach:** Keep repository dependency `supabase` pinned at 3.0.0. Test official,
checksum-verified 3.0.0 and 3.1.0 Linux binaries in a Node 24/26 matrix. Share the
stable-version gate between deployment and diagnostics. Use the conservative
compatibility expression `3.0.0 || 3.1.0`; do not claim untested patches/minors.

- [x] Compare tagged upstream command/formatter/target/consent source and binary help.
- [x] Add failing version acceptance, invalid-output and capability regressions.
- [x] Implement a shared version gate and pre-mutation command/flag preflight.
- [x] Extend existing JSON target/schema and interrupted-command safety tests.
- [x] Cover config.jsonc precedence in existing initialization/admin/doctor guards
  and prove the deployment scratch workspace excludes it.
- [x] Add real-binary tests for help flags, local migration/query/preview JSON,
  explicit target selection and closed-stdin consent; never contact hosted APIs.
- [x] Correct the discovered hosted cleanup consent handoff after regression failure;
  retain preview, declined and unattended refusal.
- [x] Run all required suites on Node 24/26 against CLI 3.0.0/3.1.0.
- [x] Document source comparison, real evidence, range, CI and hosted limitations.
- [x] Review and commit only this task's changes; preserve the Wiki migration.

## Investigation findings

3.1.0 introduces config.jsonc ahead of TOML, linked-database CA verification,
function-owned CORS and API retry controls. The targeted output fields and flags
remain structurally compatible in the tagged source; all four real-binary and
local integration matrix entries passed. See `SUPABASE-COMPATIBILITY.md` for the
exact commands, counts and hosted verification boundary. Supagame already owns function CORS and uses isolated
TOML workspaces. No TLS bypass, ambient target override, publishing or hosted
mutation is authorized. Review and execution stay inline; no subagents.

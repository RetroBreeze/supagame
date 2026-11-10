# Installation experience implementation plan

Implement the user's 10 November installation brief as one authorized change.
Use inline execution and TDD; no subagents, hosted mutations, publishing or pushes.
Preserve the untracked files inventoried at start in both repositories. Work on
`feat/installation-experience` in the requested checkout.

## Design and audit

The existing CLI already stages immutable module SQL, checks project references,
isolates deployment inputs, confirms hosted changes, and journals migrations and
function deployments. Extend those boundaries rather than introduce another deployer.

| Manual step | Classification | Delivery |
| --- | --- | --- |
| Create project, authenticate CLI, choose origins/boards | 4 — developer responsibility | Document once |
| Run supabase init first | 1 — safely automatic locally | Create minimal config only if absent |
| Set browser origins | 1 locally; 2 after authorization remotely | Optional manifest origins, additive command, secret digest verification |
| Enable hosted anonymous Auth | 2 — after authorization | Isolated one-property config, allowlisted diff, post-write read |
| Create module schema/RLS/triggers/private policies | 1 staging; 2 hosted authorization | Existing immutable module migrations |
| Enable global private-only Realtime | 4 — optional project-wide developer policy, unnecessary for this module | Preserve global setting; inspect service/catalog evidence |
| Suspended/unavailable Realtime | 2 for supported suspension PATCH after a separate operator decision; support action for administrative suspension | Report precise remediation and verification limits |
| Existing unreadable origin secret | 3 for recovering/merging unknown values; 2 for deliberate replacement | Explicit replacement flag plus normal deployment authorization |
| Upgrade modules | 1 staging; 2 hosted authorization | Existing forward-only upgrade machinery |
| Prove browser/WebSocket delivery | 4 — real consumer integration check | Doctor distinguishes catalogs/settings from end-to-end health |

Use Supabase CLI 3.0.0's supported Management API transport, including its saved
login, instead of reading private credential stores or requiring another token.
Official v3.0.0 config push source confirms only declared changed properties are
sent. A separate scratch config declares ONLY auth.enable_anonymous_sign_ins.
Accept only that actionable diff; reject missing/ambiguous evidence. Never push
the developer's full config. Secrets list returns digests, not plaintext; compare
SHA-256 and maintain a separate non-secret origin receipt for safe additive updates.
Realtime SQL prerequisites remain versioned module objects. No existing migration
or runtime HTTP contract is changed.

Official references checked 2026-11-10:
- https://supabase.com/docs/reference/api/v1-update-auth-service-config
- https://supabase.com/docs/reference/api/v1-list-all-secrets
- https://supabase.com/docs/reference/api/v1-bulk-create-secrets
- https://supabase.com/docs/reference/api/v1-get-realtime-config
- https://supabase.com/docs/reference/api/v1-get-services-health
- https://supabase.com/docs/guides/realtime/authorization
- https://supabase.com/docs/reference/cli/supabase-config-push
- https://github.com/supabase/cli/blob/v3.0.0/apps/cli/src/commands/config/push/SIDE_EFFECTS.md

## Implementation sequence

1. Add failing origin/init tests; run red; implement optional validated origins,
   fresh local bootstrap and additive `config origins add`; verify CLI regressions.
2. Add failing hosted planning/transport tests; implement strict Auth/secret
   inspection, scoped mutations and digest receipts, integrate confirmation,
   rechecks and partial failure handling; verify existing deployment safeguards.
3. Add failing doctor/catalog drift tests; implement complete live prerequisites,
   hosted configuration findings and actionable status; exercise local database.
4. Update developer quickstart/reference/troubleshooting. Run all requested suites
   with Node 24.22.2, pnpm 12.18.0, Supabase CLI 3.0.0. Pack and validate the CLI
   against Vaccoin read-only and in disposable consumer staging. Review diff and
   commit only this task's files. Record results and limitations below.

## Progress and rulings

- Audit: Supagame has only pre-existing untracked documents; Vaccoin has untracked
  supabase/ and manifest. Vaccoin manifest lists core and leaderboards, not live.
- Ruling: user explicitly requests autonomous implementation across all phases;
  this supersedes the older one-numbered-task and design approval workflow.
- Ruling: work in the requested checkout on a feature branch; preserve user files.
- Steps 1–3 complete: origin/init tests, hosted configuration tests, deployment
  safeguards and doctor drift tests were observed red before implementation and
  green afterwards. Local origin/issuer preparation preserves unrelated env data.
- Actual CLI 3.0.0 protocol inspection corrected the initial mock assumptions:
  config paths are segment arrays and classifications use `remote_only` /
  `local_only`. The parser and tests now use the pinned protocol.
- Self-review added guards for JSON-only configuration, fresh-project ignore
  rules, missing manifests, malformed origin hostnames and secret drift immediately
  before a write. No existing module migration or Edge Function was changed.
- Ruling: retain global Realtime settings. The supported PATCH API can change
  suspension/private-only/quotas, but these are project-wide operator decisions,
  not module prerequisites to silently overwrite. Expose read-only health evidence
  with an optional exported token; saved CLI login remains sufficient for normal
  provisioning. Missing evidence remains CANNOT VERIFY, not inferred health.
- Ruling: signup restrictions/CAPTCHA are preserved and explicitly reported; an
  existing-session installation can deploy without weakening those protections.
- Vaccoin's caret Supabase dependency resolved to unsupported 3.1.0 during tarball
  installation. The existing version guard stopped before hosted operations.
  Pin the consumer to 3.0.0, refresh only CLI tarball integrity, and update its
  installation instructions. Preserve its pre-existing untracked backend files.
- Review performed inline without subagents, as requested. No hosted mutation,
  artificial hosted score, publish, push or merge was performed.

- Final verification passed: pnpm test (352 tests), test:edge (80), test:db
  (709 pgTAP assertions + 18 concurrency tests), test:e2e (10 including live private
  Broadcast), typecheck, lint, build, contracts:check and test:packages. Additional
  CLI/database (23), Edge integration (12 steps), SDK integration (8) checks passed.
  Vaccoin unit tests (92), build, installed-tarball dry runs and read-only doctor
  checks completed; expected missing/unverifiable hosted findings are recorded in
  docs/installation-validation.md. No unresolved implementation blocker remains.

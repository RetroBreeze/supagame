# Supagame agent skill validation — 2026-11-16

Scope: a portable consumer integration skill, public installation instructions
and checks for its examples. No runtime, migration, package metadata or release
behavior changes. Source baseline: `975ec61`, including the existing uncommitted
npm readiness edits. Public packages are 0.1.0; current module templates are 0.1.5.

## Deliverables and installation

- `.agents/skills/supagame/SKILL.md`: discovery metadata, architecture and the
  inspect/plan/configure/integrate/verify/deploy workflow (under 600 words).
- Five bundled references: CLI/deployment, TypeScript, engine-independent HTTP,
  Cloud Saves generations and diagnostics. They work when only the skill folder
  is copied; canonical documentation links provide deeper context.
- Root README: whole-directory copy instructions, Codex discovery/invocation,
  other Agent Skills clients and the boundary between npm and skill installation.
- `tests/e2e/agent-skill.test.ts`: portable references/frontmatter, real packaged
  consumer commands/TypeScript compilation, and an optional Godot 4 transport test.
  It runs explicitly, without changing existing npm scripts or CI configuration.

Copy the complete folder into the consumer's `.agents/skills/supagame/`, or its
agent's supported equivalent. Check discovery; in Codex invoke `$supagame`.
Installing npm packages does not activate the skill. No npm inclusion was added:
there is no npm-to-agent installation mechanism, and adding files to a tarball
would not make them discoverable in a consumer. No executable skill helpers or
agent-specific tool dependencies were needed.

## Source audit

Inspected the original design/plan, current CLI registration/help, guided and
noninteractive command paths, package manifests, module inventories and
`supagame.config.json` validation, SDK exports/types, OpenAPI, Edge routes/Auth,
deployment isolation/confirmation/journals/origins, forward-only upgrades,
Cloud Saves generation protocol, latest remediation commits/ledger, README,
public Wiki, Target Rush/package consumption and security/integration tests.
The original design's feature exclusions are historical; current implementation
and this task explicitly include achievements, Cloud Saves and Live Leaderboards.

Syntax follows the [Agent Skills specification](https://agentskills.io/specification).
Codex installation was checked against [official skill discovery guidance](https://developers.openai.com/codex/skills).
Godot HTTP APIs and Unity request header handling were checked against their
respective official engine documentation linked in the HTTP reference.

## Scenario evaluation

These are **inline scenario walkthroughs plus executable contract/consumer checks**,
not independent model evaluations. No subagents or external model runs were used;
there is no measured with/without-skill agent success rate. The baseline structural
and consumer tests failed because the skill did not exist. They passed after the
skill was written. The representative responses below were checked against the
implementation and evidence listed; they are review expectations, not transcripts
from another agent.

| Developer request | Reviewed response/action | Evidence and limits |
| --- | --- | --- |
| 1. Add a leaderboard to a fresh browser game | Establish the project ref and real origin; stage Leaderboards; create points/desc/keep-best; reuse/create an explicit Auth session; integrate the published SDK; preview before hosted changes. | Packaged fresh consumer, compiled TS excerpts, local Auth/HTTP/SDK integration. CORS headers exercised over local HTTP; no new browser game UI/device acceptance run. |
| 2. Integrate into existing Supabase | Inspect existing client/Auth/config and Git changes; preserve provider settings and unrelated functions; refuse conflicting references; reuse permanent sessions. | Packaged existing-config consumer retains original Auth/function TOML, repeated init is unchanged, conflicting ref fails. Session and deployment-isolation tests pass. |
| 3. Add leaderboards to Unity | Explain backend/CLI versus HTTP adapter; use UnityWebRequest with apikey and player JWT; preserve engine config, secure token persistence and lifecycle. No official C# SDK or Vite setup. | Native consumer omits browser origins and gains no package.json. HTTP contract/Unity API documentation reviewed; Unity editor/device execution not performed. |
| 4. Add leaderboards to Godot | Use HTTPRequest, UTF-8 JSON and current session; wait for scene-tree readiness, serialize per-node requests, parse status and response; persist the submission UUID. | Godot 4.7.2 executes the actual GDScript excerpt against a loopback HTTP fixture; method/path/headers/body/result asserted. Separate real Edge/Auth checks validate the backend. Not a Godot-to-Supabase device test. |
| 5. Add offline Cloud Saves | Persist generation/UUID/revision/player/payload; preserve stale/legacy queues; explain latest 3,072 AND <30-day replay; reconcile explicitly with a new intent; retain failed-upload Blobs. | SDK generation/offline/concurrency tests, compiled durable-save excerpt, DB generation/retention/authorization tests and local deleted-save integration. No claim of perpetual replay or silent rebasing. |
| 6. Deploy the installation | Show exact destination and actual dry-run, including unrelated pending migrations, then request consent. In unattended mode, use allow-remote only for already-approved changes; preserve uncertain journals. | Packaged CLI refuses unapproved unattended deployment. Unit tests exercise preview-before-consent, declined approval, wrong destination, changed state, unrelated settings and uncertain-progress recovery using process doubles. No hosted calls/mutations. |
| 7. localhost/127.0.0.1 CORS mismatch | Recognize distinct origins; use the configured host or add the intended exact origin locally, then preview/authorize hosted update. Keep Auth redirects and unrelated settings unchanged. | Actual packaged origin-add commands preserve both intended origins; origin unit tests and local Edge CORS tests pass. Hosted secret replacement is not a default fix. |
| 8. Run without a TTY | Supply project/module, leaderboard type/order/keep-best and achievement fields; no prompt/login dependency; JSON is presentation, not authorization. | All documented marked local commands execute with no TTY and no-interactive. Fresh, existing and native fixtures pass. Missing consent fails before network access. |

Health and upgrade requests also route to the CLI/diagnostic references. Packaged
consumers run `doctor --json` and explicitly retain the database `cannot verify`
finding despite successful local checks; `upgrade --dry-run` runs against the
current modules. Known forward-upgrade paths and actual private Broadcast delivery
are covered by existing unit and SDK integration tests, respectively.

## Changes prompted by verification

The first Godot transport attempt failed because the test harness requested HTTP
before its node entered the scene tree. The harness now waits for a process frame;
the skill explicitly calls out the same lifecycle requirement for integrations.
A source/type review also corrected the account-switch reconciliation call to
`inspectAccountSwitch(transition, {flowId, restart: true})`.

A direct `doctor` invocation on `tests/fixtures/local` reported missing manifest
and project ref: that SQL/API fixture is not a CLI-installed consumer. It was not
modified to suppress those findings. The three actual packaged consumer projects
pass local doctor while reporting that live database/hosted checks were not run.

## Verification commands and results

Environment: Node v26.10.0, npm 12.2.0, Supabase CLI 3.0.0; existing dedicated local
Supabase services only. Packaged checks build and install CLI, SDK and contracts
0.1.0 from the current working tree into temporary consumer directories.

| Command | Result |
| --- | --- |
| `skills-ref validate .agents/skills/supagame` | Pass; official reference validator 0.1.0 from agentskills/agentskills revision `83021e2be457a9b6679148719c1f6074f0ad975e`, installed in a temporary venv |
| `skills-ref to-prompt .agents/skills/supagame` | Pass; discovers supagame metadata and SKILL.md location |
| skill-creator `scripts/quick_validate.py .agents/skills/supagame` | Pass |
| `node --test tests/e2e/agent-skill.test.ts` | 3 pass, including Godot (not skipped on this machine) |
| `npm test` | 45 files, 655 tests pass |
| `npm run typecheck` | Pass, including workspaces and Edge checks |
| `npm run lint` | Pass, including Edge lint/format |
| `npm run contracts:check` | Pass |
| `npm run test:edge` | 84 pass |
| `npm run test:edge:integration` | 1 test / 13 steps pass against local Supabase |
| `npm run test:sdk:integration` | 3 files, 16 tests pass, including actual private Broadcast delivery |
| Focused pgTAP command below | 5 files, 73 tests pass |
| `git diff --check` | Pass |

```sh
node_modules/.bin/supabase test db --workdir tests/fixtures/local \
  --network-id supagame-schema-tests-local \
  tests/db/cloud-saves-generations.test.sql \
  tests/db/cloud-saves-retention.test.sql \
  tests/db/cloud-saves-authorization.test.sql \
  tests/db/live.test.sql tests/db/achievements.test.sql
```

No full release matrix or full end-to-end suite was rerun for this documentation
task. Unity/Unreal runtime, exported Godot/WebGL builds, hosted deployment and a
fresh browser UI remain outside the executed checks. These are limits of the
evaluation, not claims that the backend or those engines are incompatible.

## Gaps and follow-up

The public Cloud Saves Wiki still contains older durable examples omitting
generation and a permanent-receipt-retention claim. The skill explicitly routes
to the current repository protocol and includes the correct finite guarantee.
Update that Wiki during the separately authorized documentation publication;
this task did not push to the Wiki. No API changes are needed for this skill.

No official native SDK is promised. Arbitrary/manual/cumulative achievement rules,
ascending-board achievement conditions, multiplayer, friends, seasons, streaming
save uploads and replay-based anti-cheat are not offered as implemented features.
HTTP polling is not described as verified Realtime delivery.

Pre-existing modified/untracked release/npm paths were hashed before work and
checked afterward; their bytes were preserved. Only skill, installation docs,
this validation record and its focused tests belong to the task commit. No package
publication, push, tag, visibility change or hosted mutation occurred.

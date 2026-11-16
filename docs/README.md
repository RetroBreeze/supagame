# Documentation

User guides live in the [Wiki](https://github.com/RetroBreeze/supagame/wiki).
Start with [Quickstart](https://github.com/RetroBreeze/supagame/wiki/Quickstart).
For AI-assisted game integration, install the
[Supagame skill](https://github.com/RetroBreeze/supagame/wiki/Agent-Skill).

## For contributors

- [CLI package](../packages/cli/README.md), [TypeScript SDK](../packages/sdk-ts/README.md), and [contracts](../packages/contracts/README.md).
- [Target Rush example](../examples/target-rush/README.md).
- [Local development](https://github.com/RetroBreeze/supagame/wiki/Local-Development).
- [Package maintenance](../RELEASING.md) and [compatibility record](../SUPABASE-COMPATIBILITY.md).
- [Agent integration skill](../.agents/skills/supagame/SKILL.md) and its
  [validation/scenario record](verification/AGENT-SKILL.md). Run
  `node --test tests/e2e/agent-skill.test.ts` when changing its examples.
- [Designs](superpowers/specs/) and [implementation plans](superpowers/plans/).

Edit public guides in the Wiki checkout and update its Home and sidebar when
changing navigation. Keep package READMEs focused on installing and using each
package. The [OpenAPI contract](../packages/contracts/openapi.yaml) defines the
public HTTP interface.
Current source development uses npm 12.2.0 and `npm ci`; see
[package maintenance](../RELEASING.md) for Node versions and validation commands.
The [Cloud Saves protocol](guides/cloud-save-protocol.md) is the detailed reference
for generations, finite replay and explicit reconciliation.

## Archive

[Wiki archive](https://github.com/RetroBreeze/supagame/wiki/Archive) contains dated
verification records and the former implementation reference. Historical paths
and commands describe their original revisions, not current installation steps.
[Deployment diagnostics](archive/2026-11-13-deployment-diagnostics.md) preserve
the earlier troubleshooting investigation.

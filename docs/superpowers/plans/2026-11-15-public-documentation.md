# Public documentation pass

Approved scope: present Supagame as simple game features backed by the developer's
own Supabase project. Keep the existing npm package names and assume npm availability.

One documentation task, executed inline without subagents:

- Rewrite README, Wiki home and quickstart around install, init, leaderboard creation,
  deployment and connection details.
- Consolidate CLI, SDK and feature references; archive internal records outside main navigation.
- Preserve existing user edits and historical evidence. Do not change runtime code,
  package metadata, publish packages, deploy services or push repositories.
- Check local links, command help and public setup examples; run relevant existing CLI
  checks. Documentation-only edits do not require new implementation tests or database tests.

Validation: Markdown link/anchor audit, stale installation guidance search, CLI help,
CLI unit tests, and git diff --check in both repositories. Review the final diff.

Completed: README, package guides and active Wiki pages rewritten; internal records
archived outside the sidebar. Detailed account recovery is a separate reference.
Verification: 398 CLI tests passed; CLI typecheck and lint passed; command help
checked; 205 repository/Wiki links passed the local audit; both diffs pass whitespace
checks. No database, E2E or hosted checks were run for this documentation-only pass.
No package metadata, runtime source or existing example changes were modified.

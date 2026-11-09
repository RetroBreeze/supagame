import { executePlan, planFiles } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, readManifest } from '../lib/manifest.ts';
import { definition, leaderboardSql, migrations, nextVersion } from '../lib/migration-generator.ts';
import type { BoardOptions } from '../lib/migration-generator.ts';
import { readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { MODULE_VERSION } from '../lib/templates.ts';

export function createLeaderboard(
  id: string,
  options: LocalOptions & BoardOptions,
): void {
  const board = definition(id, options);
  const { root } = readProject(options);
  const existing = readManifest(root);
  if (
    !existing || existing.value.modules.core !== MODULE_VERSION ||
    existing.value.modules.leaderboards !== MODULE_VERSION
  ) {
    throw new Error(
      'Run supagame init and supagame add leaderboards with this CLI version first.',
    );
  }
  selectedRef(root, undefined, existing.value.projectRef);
  const files = migrations(root);
  const previous = existing.value.leaderboards.find((item) => item.id === id);
  if (previous && !leaderboardSql(previous).equals(leaderboardSql(board))) {
    throw new Error(
      `Conflicting definition for ${id}; existing leaderboards are immutable.`,
    );
  }
  const suffix = `_supagame_board_${id}.sql`;
  const matches = files.filter((file) => file.name.endsWith(suffix));
  if (matches.length > 1) throw new Error(`Conflicting migrations for ${id}.`);
  if (previous && !matches.length) {
    throw new Error(
      `Restore the original migration for ${id} from version control; it may already be applied.`,
    );
  }
  const name = matches[0]?.name ?? nextVersion(files) + suffix;
  const plan = planFiles(root, [
    { path: `supabase/migrations/${name}`, content: leaderboardSql(board) },
    {
      path: MANIFEST,
      content: previous ? existing.bytes : manifestBytes({
        ...existing.value,
        leaderboards: [...existing.value.leaderboards, board],
      }),
      replace: existing.bytes,
    },
  ]);
  executePlan(root, plan, options.dryRun ?? false);
}

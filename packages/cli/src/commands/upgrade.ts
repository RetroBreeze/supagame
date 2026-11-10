import { achievementSql } from '../lib/achievements.ts';
import { existsSync } from 'node:fs';
import { executePlan, planFiles, readProjectFile, safePath } from '../lib/file-stage.ts';
import type { DesiredFile } from '../lib/file-stage.ts';
import { MANIFEST, manifestBytes, readManifest } from '../lib/manifest.ts';
import { leaderboardSql, migrations } from '../lib/migration-generator.ts';
import { functionConfig, readProject, selectedRef } from '../lib/project.ts';
import type { LocalOptions } from '../lib/project.ts';
import { templateFiles } from '../lib/templates.ts';
import { currentInventory, releaseFor, upgradePath, validateInventory } from '../lib/versions.ts';
import type { Inventory, ModuleName } from '../lib/versions.ts';

export function upgrade(
  options: LocalOptions,
  inventory: Inventory = currentInventory(templateFiles()),
): void {
  validateInventory(inventory);
  const project = readProject(options), existing = readManifest(project.root);
  if (!existing) {
    throw new Error('Missing manifest. Run supagame init and add leaderboards before upgrading.');
  }
  selectedRef(project.root, options.projectRef, existing.value.projectRef);
  if (existsSync(safePath(project.root, '.supagame-deploy-lock'))) {
    throw new Error(
      'Deployment lock exists; finish or inspect the interrupted deployment before upgrading.',
    );
  }
  if (!Object.keys(existing.value.modules).length) {
    console.log('No installed modules. Run supagame add leaderboards first.');
    return;
  }
  if (
    existing.value.modules.leaderboards &&
    releaseFor(inventory, 'leaderboards', existing.value.modules.leaderboards).requiresCore !==
      existing.value.modules.core
  ) {
    throw new Error(
      'Incompatible installed module versions; restore the expected core/leaderboards pair before upgrading.',
    );
  }
  if (existing.value.modules['live-leaderboards'] && releaseFor(inventory, 'live-leaderboards', existing.value.modules['live-leaderboards']).requiresLeaderboards !== existing.value.modules.leaderboards) throw new Error('Incompatible live-leaderboards dependency.');
  const disk = migrations(project.root);
  const value = { ...existing.value, modules: { ...existing.value.modules } };
  const desired: DesiredFile[] = [];
  let changed = false;
  for (const [name, version] of Object.entries(existing.value.modules)) {
    const module = name as ModuleName,
      installed = releaseFor(inventory, module, version),
      target = upgradePath(inventory, installed);
    for (const file of installed.migrations) {
      if (!readProjectFile(project.root, file.path)?.equals(file.content)) {
        throw new Error(
          `Conflict: restore original migration ${file.path} from Git; existing migrations are never rewritten.`,
        );
      }
    }
    for (const file of target.migrations) {
      const collision = disk.find((f) =>
        f.version === file.path.split('/').at(-1)!.slice(0, 14) &&
        `supabase/migrations/${f.name}` !== file.path
      );
      if (collision) {
        throw new Error(
          `Migration version conflict with ${collision.name}; resolve it without renaming applied migrations.`,
        );
      }
      for (const a of value.achievements ?? []) {
    const found = disk.filter(f => f.name.endsWith(`_supagame_achievement_${a.id}.sql`));
    if (found.length !== 1 || !found[0]!.content.equals(achievementSql(a))) throw new Error(`Restore original achievement migration ${a.id}.`);
  }
  desired.push({ path: file.path, content: file.content });
    }
    for (const file of target.assets) {
      const before = installed.assets.find((f) => f.path === file.path);
      const actual = readProjectFile(project.root, file.path);
      if (before && !actual) {
        throw new Error(`Missing installed asset ${file.path}; restore it before upgrading.`);
      }
      desired.push({
        path: file.path,
        content: file.content,
        ...(before ? { replace: before.content } : {}),
      });
    }
    changed ||= target.version !== installed.version;
    value.modules[module] = target.version;
    console.log(`${module}: installed ${installed.version}; available ${target.version}.`);
  }
  if (value.modules.leaderboards) {
    if (
      releaseFor(inventory, 'leaderboards', value.modules.leaderboards).requiresCore !==
        value.modules.core
    ) {
      throw new Error(
        'Incompatible module versions: leaderboards requires a matching core upgrade.',
      );
    }
    if (!functionConfig(project.bytes, project.config).equals(project.bytes)) {
      throw new Error(
        'Missing Edge Function configuration; run doctor and restore it before upgrading.',
      );
    }
  }
  if (value.modules['live-leaderboards'] && releaseFor(inventory, 'live-leaderboards', value.modules['live-leaderboards']).requiresLeaderboards !== value.modules.leaderboards) throw new Error('Incompatible live-leaderboards upgrade dependency.');
  for (const board of value.leaderboards) {
    const matches = disk.filter((f) => f.name.endsWith(`_supagame_board_${board.id}.sql`));
    if (matches.length !== 1 || !matches[0]!.content.equals(leaderboardSql(board))) {
      throw new Error(`Conflict: restore original leaderboard migration for ${board.id}.`);
    }
  }
  desired.push({ path: 'supabase/config.toml', content: project.bytes });
  desired.push({
    path: MANIFEST,
    content: changed ? manifestBytes(value) : existing.bytes,
    replace: existing.bytes,
  });
  executePlan(project.root, planFiles(project.root, desired), options.dryRun ?? false);
  console.log(
    changed
      ? 'Forward-only upgrade staged locally. Review and commit the files; deployment is a separate explicitly confirmed command.'
      : 'Up to date; no upgrade available. No files changed.',
  );
}

import { achievementSql } from './achievements.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readProjectFile, safePath } from './file-stage.ts';
import { readManifest } from './manifest.ts';
import { leaderboardSql, migrations } from './migration-generator.ts';
import { functionConfig, readProject, selectedRef } from './project.ts';
import { MODULE_VERSION, templateFiles } from './templates.ts';

export function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function deploymentFiles(root: string, ref: string) {
  const project = readProject({ workdir: root });
  const manifest = readManifest(root);
  if (
    !manifest || manifest.value.modules.core !== MODULE_VERSION ||
    manifest.value.modules.leaderboards !== MODULE_VERSION
  ) {
    throw new Error(
      'Run supagame init and supagame add leaderboards with this CLI version first.',
    );
  }
  if (manifest.value.modules['live-leaderboards'] && manifest.value.modules['live-leaderboards'] !== MODULE_VERSION) throw new Error('Use the matching CLI version for the installed live-leaderboards module.');
  if (manifest.value.modules.achievements && manifest.value.modules.achievements !== MODULE_VERSION) throw new Error('Upgrade achievements first.');
  selectedRef(root, ref, manifest.value.projectRef);
  if (!functionConfig(project.bytes, project.config).equals(project.bytes)) {
    throw new Error(
      'Missing supagame function configuration. Run supagame add leaderboards first.',
    );
  }
  const sql = migrations(root);
  const files: { path: string; content: Buffer }[] = sql.map((f) => ({
    path: `supabase/migrations/${f.name}`,
    content: f.content,
  }));
  const owned = new Set<string>();
  for (const template of templateFiles()) {
    if (template.path.endsWith('_achievements.sql') && !manifest.value.modules.achievements) continue;
    if (template.path.endsWith('_live_leaderboards.sql') && !manifest.value.modules['live-leaderboards']) continue;
    if (template.path.endsWith('.env.example')) continue;
    const actual = readProjectFile(root, template.path);
    if (!actual?.equals(template.content)) {
      throw new Error(
        `Missing or modified SDK template ${template.path}. Restore the installed version before deploying.`,
      );
    }
    if (template.path.startsWith('supabase/migrations/')) {
      owned.add(template.path.split('/').at(-1)!);
    } else files.push({ path: template.path, content: actual });
  }
  for (const board of manifest.value.leaderboards) {
    const matches = sql.filter((f) => f.name.endsWith(`_supagame_board_${board.id}.sql`));
    if (
      matches.length !== 1 || !matches[0]!.content.equals(leaderboardSql(board))
    ) {
      throw new Error(
        `Restore the original generated migration for leaderboard ${board.id}.`,
      );
    }
    owned.add(matches[0]!.name);
  }
  if (
    sql.some((f) => f.name.includes('_supagame_board_') && !owned.has(f.name))
  ) {
    throw new Error(
      'Unrecorded leaderboard migration: rerun its create command to reconcile the manifest.',
    );
  }
  for (const a of manifest.value.achievements ?? []) {
    const found = sql.filter(f => f.name.endsWith(`_supagame_achievement_${a.id}.sql`));
    if (found.length !== 1 || !found[0]!.content.equals(achievementSql(a))) throw new Error(`Restore achievement migration ${a.id}.`);
    owned.add(found[0]!.name);
  }
  if (sql.some(f => f.name.includes('_supagame_achievement_') && !owned.has(f.name))) throw new Error('Unrecorded achievement migration.');
  const functionHash = digest(
    Buffer.concat(
      files.filter((f) => f.path.includes('/functions/')).flatMap(
        (f) => [Buffer.from(f.path + '\0'), f.content],
      ),
    ),
  );
  const fingerprint = digest(
    Buffer.concat([
      manifest.bytes,
      project.bytes,
      ...files.flatMap((f) => [Buffer.from(f.path + '\0'), f.content]),
    ]),
  );
  return { files, sql, owned, functionHash, fingerprint };
}
export function isolatedProject(files: ReturnType<typeof deploymentFiles>) {
  const directory = mkdtempSync(join(tmpdir(), 'supagame-deploy-'));
  try {
    const config =
      'project_id = "supagame-deployment"\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n[functions.supagame]\nenabled = true\nverify_jwt = false\nentrypoint = "./functions/supagame/index.ts"\nimport_map = "./functions/supagame/deno.json"\n';
    for (
      const file of [...files.files, {
        path: 'supabase/config.toml',
        content: Buffer.from(config),
      }]
    ) {
      const destination = join(directory, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content, { flag: 'wx', mode: 0o600 });
    }
    return {
      directory,
      remove: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
// A killed process leaves this lock intentionally: recovery requires an operator to
// establish that no deployment is still running before removing it. Never steal it.
export function deploymentLock(root: string): () => void {
  const path = safePath(root, '.supagame-deploy-lock');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new Error(
      'Deployment lock exists or cannot be created. Check for a running/interrupted deployment; inspect remote progress before removing .supagame-deploy-lock.',
    );
  }
  writeFileSync(
    join(path, 'owner.json'),
    JSON.stringify({ pid: process.pid }),
    { flag: 'wx', mode: 0o600 },
  );
  return () => rmSync(path, { recursive: true });
}

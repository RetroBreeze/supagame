import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const ref = 'abcdefghijklmnopqrst';
export const config =
  '# Keep my formatting\r\nproject_id = "local-game"\r\n[auth]\r\nenable_anonymous_sign_ins = true\r\n';
export function project(supabase = true) {
  const root = mkdtempSync(join(tmpdir(), 'supagame-cli-'));
  if (supabase) put(root, 'supabase/config.toml', config);
  return root;
}
export function put(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}
export function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    join(repo, 'packages/cli/src/cli.ts'),
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, SUPABASE_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' },
  });
}
export function snapshot(
  root: string,
): Record<string, { content: string; mode: number; mtime: number }> {
  const result: ReturnType<typeof snapshot> = {};
  function walk(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const relative = path ? `${path}/${name}` : name;
      const file = join(root, relative);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        result[relative] = {
          content: `link:${readlinkSync(file)}`,
          mode: stat.mode,
          mtime: stat.mtimeMs,
        };
      } else if (stat.isDirectory()) walk(relative);
      else {result[relative] = {
          content: readFileSync(file).toString('base64'),
          mode: stat.mode,
          mtime: stat.mtimeMs,
        };}
    }
  }
  walk('');
  return result;
}
export function manifest(root: string) {
  return JSON.parse(readFileSync(join(root, 'supagame.config.json'), 'utf8'));
}
export function initialized(root: string) {
  put(
    root,
    'supagame.config.json',
    JSON.stringify(
      { formatVersion: 1, projectRef: ref, modules: {}, leaderboards: [] },
      null,
      4,
    ) + '\n',
  );
}

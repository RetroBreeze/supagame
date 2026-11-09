import { afterAll, beforeAll, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { project, put, ref, repo, snapshot } from './project-fixture.ts';
const root = project();
const tool = join(root, 'tool');
beforeAll(() => {
  execFileSync(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(repo, 'packages/cli/tsconfig.json'),
  ]);
  execFileSync(process.execPath, [
    join(repo, 'packages/cli/scripts/copy-assets.ts'),
  ]);
  mkdirSync(tool);
  cpSync(join(repo, 'packages/cli/dist'), join(tool, 'dist'), {
    recursive: true,
  });
  put(tool, 'package.json', '{"type":"module"}');
  symlinkSync(
    join(repo, 'packages/cli/node_modules'),
    join(tool, 'node_modules'),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
it(
  'built CLI stages from its own bundled assets and the copied Edge graph typechecks',
  () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(tool, 'dist/cli.js'), ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    let result = run('init', '--project-ref', ref);
    expect(result.status, result.stderr).toBe(0);
    result = run('add', 'leaderboards');
    expect(result.status, result.stderr).toBe(0);
    const before = snapshot(join(root, 'supabase'));
    result = run('add', 'leaderboards');
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(join(root, 'supabase'))).toEqual(before);
    result = run('leaderboard', 'create', 'level-1', '--type', 'time', '--order', 'asc', '--keep-best');
    expect(result.status, result.stderr).toBe(0);
    const configured = snapshot(join(root, 'supabase'));
    expect(run('leaderboard', 'create', 'level-1', '--type', 'time', '--order', 'asc', '--keep-best').status).toBe(0);
    expect(snapshot(join(root, 'supabase'))).toEqual(configured);
    result = run('deploy', '--project-ref', ref);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--allow-remote');
    const maintained = snapshot(join(root, 'supabase'));
    result = run('doctor');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HEALTHY');
    result = run('upgrade', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no upgrade available');
    expect(snapshot(join(root, 'supabase'))).toEqual(maintained);
    const functionRoot = join(root, 'supabase/functions/supagame');
    expect(readFileSync(join(functionRoot, 'deno.lock'), 'utf8')).not.toContain(
      '"workspace"',
    );
    const checked = spawnSync(join(repo, 'node_modules/.bin/deno'), [
      'check',
      '--frozen',
      '--config',
      join(functionRoot, 'deno.json'),
      join(functionRoot, 'index.ts'),
    ], { cwd: root, encoding: 'utf8', timeout: 60000 });
    expect(checked.status, checked.stderr).toBe(0);
  },
  60000,
);

it('bundles only the versioned allowlist, excluding local or hidden module files', () => {
  const expected = [
    'deno.lock',
    'modules/core/migrations/001_players.sql',
    'modules/core/migrations/002_player_functions.sql',
    'modules/leaderboards/migrations/001_leaderboards.sql',
    'modules/leaderboards/migrations/002_submit_score.sql',
    'modules/leaderboards/migrations/003_rank_reads.sql',
    ...['index.ts', 'routes.ts', 'auth.ts', 'responses.ts', 'types.ts', 'validation.ts'].map(
      (name) => `modules/leaderboards/functions/supagame/${name}`,
    ),
    'packages/contracts/src/generated.ts',
  ].sort();
  expect(Object.keys(snapshot(join(tool, 'dist/assets'))).sort()).toEqual(expected);
});

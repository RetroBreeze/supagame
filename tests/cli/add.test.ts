import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  cli,
  config,
  initialized,
  manifest,
  project,
  put,
  repo,
  snapshot,
} from './project-fixture.ts';
const roots: string[] = [];
function fixture() {
  const root = project();
  roots.push(root);
  initialized(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const migrations = [
  ['core/001_players.sql', '20261108000100_core_players.sql'],
  ['leaderboards/001_leaderboards.sql', '20261108000200_leaderboards.sql'],
  ['core/002_player_functions.sql', '20261108000300_core_player_functions.sql'],
  ['leaderboards/002_submit_score.sql', '20261108000400_submit_score.sql'],
  ['leaderboards/003_rank_reads.sql', '20261108000500_rank_reads.sql'],
];
describe('add leaderboards', () => {
  it('installs exact migration versions and a self-contained Edge function, preserving unrelated files', () => {
    const root = fixture();
    put(root, 'supabase/migrations/20200101000000_custom.sql', 'select 1;');
    put(root, 'supabase/functions/custom/index.ts', '// owned by user');
    const before = snapshot(root);
    const result = cli(root, 'add', 'leaderboards');
    expect(result.status, result.stderr).toBe(0);
    for (const [source, name] of migrations) {
      const [module, file] = source!.split('/');
      expect(readFileSync(join(root, 'supabase/migrations', name!))).toEqual(
        readFileSync(join(repo, 'modules', module!, 'migrations', file!)),
      );
    }
    expect(readdirSync(join(root, 'supabase/migrations'))).toHaveLength(6);
    for (
      const name of [
        'index.ts',
        'routes.ts',
        'auth.ts',
        'responses.ts',
        'validation.ts',
      ]
    ) {
      expect(readFileSync(join(root, 'supabase/functions/supagame', name)))
        .toEqual(
          readFileSync(
            join(repo, 'modules/leaderboards/functions/supagame', name),
          ),
        );
    }
    expect(
      readFileSync(join(root, 'supabase/functions/supagame/types.ts'), 'utf8'),
    ).toContain("'./contracts.generated.ts'");
    expect(
      readFileSync(
        join(root, 'supabase/functions/supagame/contracts.generated.ts'),
      ),
    ).toEqual(readFileSync(join(repo, 'packages/contracts/src/generated.ts')));
    expect(manifest(root).modules).toEqual({
      core: '0.1.3',
      leaderboards: '0.1.3',
    });
    expect(readFileSync(join(root, 'supabase/config.toml'), 'utf8')).toContain(
      config,
    );
    expect(readFileSync(join(root, 'supabase/config.toml'), 'utf8')).toContain(
      'verify_jwt = false',
    );
    for (
      const path of [
        'supabase/migrations/20200101000000_custom.sql',
        'supabase/functions/custom/index.ts',
      ]
    ) expect(snapshot(root)[path]).toEqual(before[path]);
  });
  it('repeated installation preserves bytes, file modes and timestamps', () => {
    const root = fixture();
    expect(cli(root, 'add', 'leaderboards').status).toBe(0);
    const before = snapshot(root);
    const result = cli(root, 'add', 'leaderboards');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/^(create|update) /m);
    expect(snapshot(root)).toEqual(before);
  });
  it('dry run shows planned updates, creates and unchanged files without mutation', () => {
    const root = fixture();
    const before = snapshot(root);
    const result = cli(root, 'add', 'leaderboards', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('update supagame.config.json');
    expect(result.stdout).toContain('update supabase/config.toml');
    expect(result.stdout).toContain(
      'create supabase/functions/supagame/index.ts',
    );
    expect(snapshot(root)).toEqual(before);
  });
  it.each([false, true])(
    'detects all conflicting paths before any writes (dry run=%s)',
    (dry) => {
      const root = fixture();
      put(root, 'supabase/functions/supagame/index.ts', '// user function');
      put(
        root,
        'supabase/migrations/20261108000100_core_players.sql',
        'select 2;',
      );
      const before = snapshot(root);
      const result = cli(
        root,
        'add',
        'leaderboards',
        ...(dry ? ['--dry-run'] : []),
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'conflict supabase/functions/supagame/index.ts',
      );
      expect(result.stdout + result.stderr).toContain(
        'conflict supabase/migrations/20261108000100_core_players.sql',
      );
      expect(snapshot(root)).toEqual(before);
    },
  );
  it('rejects another migration with the same version prefix', () => {
    const root = fixture();
    put(root, 'supabase/migrations/20261108000100_other.sql', 'select 1;');
    const before = snapshot(root);
    expect(cli(root, 'add', 'leaderboards').stderr).toMatch(
      /migration.*20261108000100/i,
    );
    expect(snapshot(root)).toEqual(before);
  });
  it('requires init, rejects unknown modules and refuses an unsupported installed version', () => {
    const root = fixture();
    rmSync(join(root, 'supagame.config.json'));
    expect(cli(root, 'add', 'leaderboards').stderr).toContain('supagame init');
    initialized(root);
    expect(cli(root, 'add', 'unknown-module').stderr).toContain('Unknown module');
    const value = manifest(root);
    value.modules = { core: '0.2.0', leaderboards: '0.2.0' };
    put(root, 'supagame.config.json', JSON.stringify(value));
    const before = snapshot(root);
    expect(cli(root, 'add', 'leaderboards').stderr).toMatch(/version/i);
    expect(snapshot(root)).toEqual(before);
  });
  it('does not overwrite incompatible function configuration', () => {
    const root = fixture();
    put(
      root,
      'supabase/config.toml',
      config + '\n[functions.supagame]\nverify_jwt = true\n',
    );
    const before = snapshot(root);
    const result = cli(root, 'add', 'leaderboards');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify_jwt');
    expect(snapshot(root)).toEqual(before);
  });
  it('rejects symlinked target ancestors without writing outside the project', () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, 'supabase/functions'));
    const before = snapshot(outside);
    expect(cli(root, 'add', 'leaderboards').stderr).toMatch(/symlink/i);
    expect(snapshot(outside)).toEqual(before);
  });
  it('repairs a missing staged file but refuses user edits', () => {
    const root = fixture();
    expect(cli(root, 'add', 'leaderboards').status).toBe(0);
    const file = join(root, 'supabase/functions/supagame/routes.ts');
    rmSync(file);
    expect(cli(root, 'add', 'leaderboards').status).toBe(0);
    put(root, 'supabase/functions/supagame/routes.ts', '// edited');
    const before = snapshot(root);
    expect(cli(root, 'add', 'leaderboards').status).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });
});

it('dry run reports a live staging lock without changing it', () => {
  const root = fixture();
  put(root, '.supagame-stage/owner.json', JSON.stringify({ pid: process.pid, host: hostname() }));
  const before = snapshot(root);
  const result = cli(root, 'add', 'leaderboards', '--dry-run');
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain('conflict .supagame-stage');
  expect(snapshot(root)).toEqual(before);
});

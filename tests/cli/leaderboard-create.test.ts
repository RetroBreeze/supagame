import { readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cli, initialized, manifest, project, put, snapshot } from './project-fixture.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function installed() {
  const root = project();
  roots.push(root);
  initialized(root);
  const result = cli(root, 'add', 'leaderboards');
  expect(result.status, result.stderr).toBe(0);
  return root;
}
const options = ['--type', 'time', '--order', 'asc', '--keep-best'];
function create(root: string, id = 'level-1', extra: string[] = []) {
  return cli(root, 'leaderboard', 'create', id, ...options, ...extra);
}
function migration(root: string) {
  return readdirSync(join(root, 'supabase/migrations')).find((file) =>
    file.endsWith('_supagame_board_level-1.sql')
  )!;
}
it('records the definition and deterministic additive SQL without altering unrelated files', () => {
  const root = installed();
  put(root, 'notes.txt', 'keep me');
  const config = readFileSync(join(root, 'supabase/config.toml'));
  const result = create(root, 'level-1', ['--min', '-10', '--max', '100']);
  expect(result.status, result.stderr).toBe(0);
  expect(manifest(root).leaderboards).toEqual([{
    id: 'level-1',
    kind: 'time',
    sortDirection: 'asc',
    keepBest: true,
    minValue: -10,
    maxValue: 100,
  }]);
  expect(migration(root)).toBe('20261108000501_supagame_board_level-1.sql');
  const sql = readFileSync(
    join(root, 'supabase/migrations', migration(root)),
    'utf8',
  );
  expect(sql).toContain('public.game_leaderboards');
  expect(sql).toContain('on conflict (id) do nothing');
  expect(sql).not.toMatch(/\b(?:delete|drop|update public)\b/i);
  expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('keep me');
  expect(readFileSync(join(root, 'supabase/config.toml'))).toEqual(config);
  const other = installed();
  create(other, 'level-1', ['--min', '-10', '--max', '100']);
  expect(
    readFileSync(join(other, 'supabase/migrations', migration(other)), 'utf8'),
  ).toBe(sql);
});
it('identical commands preserve bytes and mtimes, while conflicting definitions fail', () => {
  const root = installed();
  expect(create(root).status).toBe(0);
  const before = snapshot(root);
  expect(create(root).status).toBe(0);
  expect(snapshot(root)).toEqual(before);
  const conflict = create(root, 'level-1', ['--max', '100']);
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toMatch(/conflict/i);
  expect(snapshot(root)).toEqual(before);
});
it.each([
  '../escape',
  'UPPER',
  "x'; drop table public.game_players;--",
  'x'.repeat(65),
  'a\\b',
])('rejects unsafe ID %s without writes', (id) => {
  const root = installed();
  const before = snapshot(root);
  expect(create(root, id).status).toBe(1);
  expect(snapshot(root)).toEqual(before);
});
it.each(
  [
    ['--min', '1.2'],
    ['--min', '1e3'],
    ['--max', '9007199254740992'],
    ['--min', '10', '--max', '9'],
    ['--min', '0);select 1;--'],
    ['--type', 'other'],
    ['--order', 'other'],
  ].map((extra) => ({ extra })),
)('rejects invalid configuration $extra', ({ extra }) => {
  const root = installed();
  const before = snapshot(root);
  expect(create(root, 'level-1', extra).status).toBe(1);
  expect(snapshot(root)).toEqual(before);
});
it('requires keep-best explicitly', () => {
  const root = installed();
  expect(
    cli(
      root,
      'leaderboard',
      'create',
      'level-1',
      '--type',
      'points',
      '--order',
      'desc',
    ).status,
  ).toBe(1);
});
it('previews without writes and handles timestamp rollover after existing migrations', () => {
  const root = installed();
  put(root, 'supabase/migrations/20261231235959_existing.sql', 'select 1;');
  const before = snapshot(root);
  const dry = create(root, 'level-1', ['--dry-run']);
  expect(dry.status, dry.stderr).toBe(0);
  expect(dry.stdout).toContain('20270101000000_supagame_board_level-1.sql');
  expect(snapshot(root)).toEqual(before);
  expect(create(root).status).toBe(0);
  expect(migration(root)).toBe('20270101000000_supagame_board_level-1.sql');
});
it('recovers a completed SQL write without a manifest update; never regenerates a missing applied migration', () => {
  const root = installed();
  const original = readFileSync(join(root, 'supagame.config.json'), 'utf8');
  expect(create(root).status).toBe(0);
  const name = migration(root);
  put(root, 'supagame.config.json', original);
  expect(create(root).status).toBe(0);
  expect(migration(root)).toBe(name);
  expect(manifest(root).leaderboards).toHaveLength(1);
  unlinkSync(join(root, 'supabase/migrations', name));
  expect(create(root).stderr).toMatch(/restore.*migration/i);
});
it('rejects changed SQL and duplicate migration versions', () => {
  const root = installed();
  expect(create(root).status).toBe(0);
  put(root, `supabase/migrations/${migration(root)}`, 'select 0;');
  expect(create(root).stderr).toMatch(/conflict/i);
  put(root, 'supabase/migrations/20261108000100_other.sql', 'select 1;');
  expect(create(root, 'level-2').stderr).toMatch(/duplicate.*version/i);
});

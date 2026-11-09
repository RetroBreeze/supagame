import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  cli,
  config,
  initialized,
  manifest,
  project,
  put,
  ref,
  snapshot,
} from './project-fixture.ts';
const roots: string[] = [];
function fixture(supabase = true) {
  const root = project(supabase);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
describe('init', () => {
  it('initializes an existing Supabase project without changing existing files', () => {
    const root = fixture();
    put(root, 'notes.txt', 'user data');
    const before = snapshot(root);
    const result = cli(root, 'init', '--project-ref', ref);
    expect(result.status, result.stderr).toBe(0);
    expect(manifest(root)).toEqual({
      formatVersion: 1,
      projectRef: ref,
      modules: {},
      leaderboards: [],
    });
    for (const [path, value] of Object.entries(before)) {
      expect(snapshot(root)[path]).toEqual(value);
    }
    expect(result.stdout).toContain(ref);
  });
  it('requires Supabase initialization in empty directories; never searches parents', () => {
    const root = fixture(false);
    const before = snapshot(root);
    const result = cli(root, 'init', '--project-ref', ref);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('supabase init');
    expect(snapshot(root)).toEqual(before);
  });
  it('uses local link metadata but never environment variables or local project_id as a remote ref', () => {
    const root = fixture();
    const before = snapshot(root);
    expect(cli(root, 'init').stderr).toContain('--project-ref');
    expect(snapshot(root)).toEqual(before);
    put(root, 'supabase/.temp/project-ref', `${ref}\n`);
    expect(cli(root, 'init').status).toBe(0);
    expect(manifest(root).projectRef).toBe(ref);
  });
  it('rejects ambiguous link metadata and explicit reference mismatches', () => {
    const root = fixture();
    put(root, 'supabase/.temp/project-ref', ref);
    const before = snapshot(root);
    expect(cli(root, 'init', '--project-ref', 'zzzzzzzzzzzzzzzzzzzz').stderr)
      .toMatch(/mismatch|disagree/i);
    expect(snapshot(root)).toEqual(before);
    put(
      root,
      'supabase/.temp/linked-project.json',
      JSON.stringify({ ref: 'zzzzzzzzzzzzzzzzzzzz' }),
    );
    expect(cli(root, 'init').status).toBe(1);
  });
  it('repeats without reformatting or rewriting the manifest', () => {
    const root = fixture();
    initialized(root);
    const before = snapshot(root);
    const result = cli(root, 'init');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unchanged');
    expect(snapshot(root)).toEqual(before);
  });
  it('previews create and unchanged paths without writes', () => {
    const root = fixture();
    const before = snapshot(root);
    const result = cli(root, 'init', '--project-ref', ref, '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('create supagame.config.json');
    expect(result.stdout).toContain('unchanged supabase/config.toml');
    expect(snapshot(root)).toEqual(before);
  });
  it.each([
    '{',
    '{}',
    '{"formatVersion":99}',
    JSON.stringify({
      formatVersion: 1,
      projectRef: ref,
      modules: [],
      leaderboards: [],
    }),
    JSON.stringify({
      formatVersion: 1,
      projectRef: ref,
      modules: {},
      leaderboards: [],
      secret: 'do-not-print',
    }),
  ])('rejects invalid manifests without printing their contents', (content) => {
    const root = fixture();
    put(root, 'supagame.config.json', content);
    const before = snapshot(root);
    const result = cli(root, 'init', '--project-ref', ref);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('supagame.config.json');
    expect(result.stderr).not.toContain('do-not-print');
    expect(snapshot(root)).toEqual(before);
  });
  it('rejects malformed TOML and invalid project references', () => {
    const root = fixture();
    expect(cli(root, 'init', '--project-ref', '../outside').status).toBe(1);
    put(root, 'supabase/config.toml', '[broken');
    expect(cli(root, 'init', '--project-ref', ref).stderr).toContain(
      'config.toml',
    );
  });
  it('rejects symlinked Supabase directories and manifests', () => {
    const root = fixture(false);
    const outside = fixture();
    symlinkSync(join(outside, 'supabase'), join(root, 'supabase'));
    expect(cli(root, 'init', '--project-ref', ref).stderr).toMatch(/symlink/i);
    expect(readFileSync(join(outside, 'supabase/config.toml'), 'utf8')).toBe(
      config,
    );
    const another = fixture();
    put(outside, 'manifest.json', '{}');
    symlinkSync(
      join(outside, 'manifest.json'),
      join(another, 'supagame.config.json'),
    );
    expect(cli(another, 'init', '--project-ref', ref).stderr).toMatch(
      /symlink/i,
    );
  });
  it('accepts an explicit workdir without touching the calling directory', () => {
    const caller = fixture(false);
    const target = fixture();
    const result = cli(
      caller,
      'init',
      '--workdir',
      target,
      '--project-ref',
      ref,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(manifest(target).projectRef).toBe(ref);
    expect(snapshot(caller)).toEqual({});
  });
});

it('rejects non-string leaderboard enums', () => {
  const root = fixture();
  const value = {
    formatVersion: 1,
    projectRef: ref,
    modules: { core: '0.1.0', leaderboards: '0.1.0' },
    leaderboards: [{
      id: 'arcade',
      kind: ['points'],
      sortDirection: 'desc',
      keepBest: true,
      minValue: null,
      maxValue: null,
    }],
  };
  put(root, 'supagame.config.json', JSON.stringify(value));
  expect(cli(root, 'init').status).toBe(1);
});

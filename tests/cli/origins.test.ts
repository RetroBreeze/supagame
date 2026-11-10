import { afterEach, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cli, initialized, manifest, project, put, ref, snapshot } from './project-fixture.ts';
const roots: string[] = [];
const fixture = (existing = true) => {
  const root = project(existing);
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('initializes with normalized, deduplicated origins and preserves existing settings', () => {
  const root = fixture();
  const config = readFileSync(join(root, 'supabase/config.toml'));
  const result = cli(
    root,
    'init',
    '--project-ref',
    ref,
    '--origin',
    'http://LOCALHOST:5173/',
    '--origin',
    'http://localhost:5173',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(manifest(root).origins).toEqual(['http://localhost:5173']);
  expect(readFileSync(join(root, 'supabase/config.toml'))).toEqual(config);
  const before = snapshot(root);
  expect(cli(root, 'init', '--origin', 'http://localhost:5173').status).toBe(0);
  expect(snapshot(root)).toEqual(before);
});
it('adds origins to legacy manifests and retains them through module installation and upgrade', () => {
  const root = fixture();
  initialized(root);
  expect(cli(root, 'config', 'origins', 'add', 'http://10.0.0.15:5173').status)
    .toBe(0);
  expect(cli(root, 'init', '--origin', 'https://game.example:443').status).toBe(
    0,
  );
  expect(cli(root, 'add', 'live-leaderboards').status).toBe(0);
  expect(cli(root, 'upgrade').status).toBe(0);
  expect(manifest(root).origins).toEqual([
    'http://10.0.0.15:5173',
    'https://game.example',
  ]);
  const before = snapshot(root);
  expect(cli(root, 'config', 'origins', 'add', 'https://game.example').status)
    .toBe(0);
  expect(snapshot(root)).toEqual(before);
});
it.each([
  '*',
  'null',
  'file:///tmp/game',
  'javascript:alert(1)',
  'https://user:password@example.com',
  'https://a.test/path',
  'https://a.test?token=secret',
  'https://a.test#',
  'https://*.example',
  ' https://a.test',
  'https://a.test\n',
  'https://a.test\\evil',
  'https://',
  'https://a.test:99999',
  "https://a'b.test",
  'https:///a.test',
  'https://a..test',
])('rejects unsafe origins without writing or echoing values: %s', (origin) => {
  const root = fixture(false);
  const before = snapshot(root);
  const result = cli(root, 'init', '--project-ref', ref, '--origin', origin);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/origin/i);
  expect(result.stderr).not.toMatch(/password|token=secret|a\.test/);
  expect(snapshot(root)).toEqual(before);
});
it('previews both fresh and additive configuration without writes', () => {
  const root = fixture(false);
  const before = snapshot(root);
  expect(
    cli(
      root,
      'init',
      '--project-ref',
      ref,
      '--origin',
      'http://localhost:5173',
      '--dry-run',
    ).status,
  ).toBe(0);
  expect(snapshot(root)).toEqual(before);
  expect(cli(root, 'init', '--project-ref', ref).status).toBe(0);
  const initialized = snapshot(root);
  expect(
    cli(root, 'config', 'origins', 'add', 'http://localhost:5173', '--dry-run')
      .status,
  ).toBe(0);
  expect(snapshot(root)).toEqual(initialized);
});
it('refuses invalid manifest origins without changing developer data', () => {
  const root = fixture();
  initialized(root);
  const value = manifest(root);
  value.origins = ['*'];
  put(root, 'supagame.config.json', JSON.stringify(value));
  const before = snapshot(root);
  expect(cli(root, 'config', 'origins', 'add', 'http://localhost:5173').status)
    .toBe(1);
  expect(snapshot(root)).toEqual(before);
});
it('prepares local browser runtime configuration and preserves unrelated environment settings', () => {
  const root = fixture();
  put(
    root,
    'supabase/functions/.env',
    'OTHER_SECRET=do-not-print\nSG_ALLOWED_ORIGINS=\'["https://existing.test"]\'\n',
  );
  put(root, '.gitignore', '# developer ignores\nnode_modules/\n');
  const result = cli(
    root,
    'init',
    '--project-ref',
    ref,
    '--origin',
    'http://localhost:5173',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('do-not-print');
  const env = readFileSync(join(root, 'supabase/functions/.env'), 'utf8');
  expect(env).toContain('OTHER_SECRET=do-not-print\n');
  expect(env).toContain('https://existing.test');
  expect(env).toContain('http://localhost:5173');
  expect(env).toContain('SG_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1');
  expect(manifest(root).origins).toEqual([
    'https://existing.test',
    'http://localhost:5173',
  ]);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain(
    '# developer ignores\nnode_modules/\n',
  );
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain(
    '/supabase/functions/.env',
  );
});
it('refuses unreadable local origins rather than overwriting them', () => {
  const root = fixture();
  put(root, 'supabase/functions/.env', 'SG_ALLOWED_ORIGINS=env(MY_ORIGINS)\n');
  const before = snapshot(root);
  const result = cli(
    root,
    'init',
    '--project-ref',
    ref,
    '--origin',
    'http://localhost:5173',
  );
  expect(result.status).toBe(1);
  expect(snapshot(root)).toEqual(before);
});
it('preserves an explicit local issuer and uses the configured API port otherwise', () => {
  const root = fixture();
  put(root, 'supabase/config.toml', 'project_id="test"\n[api]\nport=55431\n');
  expect(
    cli(root, 'init', '--project-ref', ref, '--origin', 'http://localhost:5173')
      .status,
  ).toBe(0);
  expect(readFileSync(join(root, 'supabase/functions/.env'), 'utf8')).toContain(
    ':55431/auth/v1',
  );
  put(
    root,
    'supabase/functions/.env',
    'SG_AUTH_ISSUER=https://auth.example.test/auth/v1\n',
  );
  expect(cli(root, 'config', 'origins', 'add', 'https://game.test').status)
    .toBe(0);
  expect(readFileSync(join(root, 'supabase/functions/.env'), 'utf8')).toContain(
    'SG_AUTH_ISSUER=https://auth.example.test/auth/v1',
  );
});

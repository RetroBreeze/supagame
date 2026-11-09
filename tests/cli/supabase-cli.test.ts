import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { processEnvironment, runSupabase } from '../../packages/cli/src/lib/supabase-cli.ts';
import { project, put } from './project-fixture.ts';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it('removes ambient target, consent, dotenv and runtime overrides from child environment', () => {
  const env = processEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    SUPABASE_YES: 'true',
    SUPABASE_PROJECT_ID: 'wrong',
    SUPABASE_DB_SEED_ENABLED: 'true',
    NODE_OPTIONS: '--require evil.js',
    PGHOST: 'remote',
    CI: 'true',
  });
  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/home/test',
    SUPABASE_YES: 'false',
  });
});
it('uses literal process arguments, closes stdin and sanitizes the real subprocess environment', async () => {
  const root = project();
  roots.push(root);
  put(
    root,
    'bin/supabase',
    `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), consent: process.env.SUPABASE_YES, target: process.env.SUPABASE_PROJECT_ID ?? null})));\n`,
  );
  chmodSync(join(root, 'bin/supabase'), 0o700);
  vi.stubEnv('PATH', join(root, 'bin'));
  vi.stubEnv('SUPABASE_YES', 'true');
  vi.stubEnv('SUPABASE_PROJECT_ID', 'wrong');
  const result = await runSupabase(
    ['--version', '$(touch NEVER); literal'],
    root,
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    args: ['--version', '$(touch NEVER); literal'],
    cwd: root,
    consent: 'false',
    target: null,
  });
});
it('reports unavailable executables without hanging or throwing credential-bearing errors', async () => {
  const root = project();
  roots.push(root);
  vi.stubEnv('PATH', root);
  expect((await runSupabase(['--version'], root)).code).toBeNull();
});

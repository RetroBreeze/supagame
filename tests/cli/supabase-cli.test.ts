import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSupabaseRunner, processEnvironment, runSupabase, SupabaseCli } from '../../packages/cli/src/lib/supabase-cli.ts';
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
it.each(['timeout', 'abort'])('treats actual subprocess %s as failure', async (mode) => {
  const root = project();
  roots.push(root);
  put(root, 'bin/supabase', `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(join(root, 'bin/supabase'), 0o700);
  vi.stubEnv('PATH', join(root, 'bin'));
  const controller = new AbortController();
  const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined;
  try {
    const run = createSupabaseRunner(mode === 'timeout' ? 50 : 1000, controller.signal);
    expect((await run(['--version'], root)).code).toBeNull();
  } finally { clearTimeout(timer); }
});
it('preserves Linux credential-store discovery while stripping deployment overrides', async () => {
  const root = project();
  roots.push(root);
  put(root, 'bin/supabase', `#!${process.execPath}\nconsole.log(JSON.stringify({bus: process.env.DBUS_SESSION_BUS_ADDRESS, runtime: process.env.XDG_RUNTIME_DIR, consent: process.env.SUPABASE_YES, override: process.env.SUPABASE_CLI_BINARY_OVERRIDE ?? null}));\n`);
  chmodSync(join(root, 'bin/supabase'), 0o700);
  vi.stubEnv('PATH', join(root, 'bin'));
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1234/bus');
  vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1234');
  vi.stubEnv('SUPABASE_CLI_BINARY_OVERRIDE', '/untrusted/binary');
  const result = await runSupabase(['--version'], root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    bus: 'unix:path=/run/user/1234/bus',
    runtime: '/run/user/1234',
    consent: 'false',
    override: null,
  });
});

it.each([
  { operation: 'version check', action: (cli: SupabaseCli) => cli.checkVersion() },
  { operation: 'migration inspection', action: (cli: SupabaseCli) => cli.inspect([]) },
  { operation: 'database preview', action: (cli: SupabaseCli) => cli.inspect([]) },
  { operation: 'function inspection', action: (cli: SupabaseCli) => cli.functionInfo() },
  { operation: 'database deployment', action: (cli: SupabaseCli) => cli.push() },
  { operation: 'function deployment', action: (cli: SupabaseCli) => cli.deployFunction() },
])('identifies $operation failures without exposing subprocess data', async ({ operation, action }) => {
  const ref = 'abcdefghijklmnopqrst';
  for (const throws of [false, true]) {
    const cli = new SupabaseCli(async (args) => {
      if (operation === 'database preview' && args[0] === 'migration') {
        return { code: 0, stdout: JSON.stringify({ target: { kind: 'linked', project_ref: ref }, migrations: [] }), stderr: '' };
      }
      if (throws) throw new Error('SECRET credential in spawn error');
      return { code: 1, stdout: 'SECRET token', stderr: 'SECRET password' };
    }, '/isolated', ref);
    let message = '';
    try { await action(cli); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(operation);
    expect(message).toContain('raw output is withheld');
    expect(message).not.toContain('SECRET');
  }
});

it.each(['3.0.0', '3.1.0', '3.1.0\r\n'])('accepts tested stable version %j for deployment and diagnostics', async (version) => {
  const run = async () => ({ code: 0, stdout: version, stderr: 'update notice on stderr' });
  await expect(new SupabaseCli(run, '/isolated', 'abcdefghijklmnopqrst').checkVersion()).resolves.toBeUndefined();
  const { DoctorInspector } = await import('../../packages/cli/src/lib/doctor-inspect.ts');
  await expect(new DoctorInspector(run, '/isolated', { projectId: 'test', port: 55432 }).version()).resolves.toBeUndefined();
});

it.each(['2.99.0', '4.0.0', '3.2.0', '3.0.1', '3.1.1', '3.1.0-beta.1', '3.1.0+custom', 'v3.1.0', '', '3.01.0', '3.1', '3.1.0\nextra', '{"version":"3.1.0"}'])('rejects unsupported or malformed version %j without echoing it', async (version) => {
  const run = async () => ({ code: 0, stdout: version, stderr: '' });
  const { DoctorInspector } = await import('../../packages/cli/src/lib/doctor-inspect.ts');
  for (const check of [
    () => new SupabaseCli(run, '/isolated', 'abcdefghijklmnopqrst').checkVersion(),
    () => new DoctorInspector(run, '/isolated', { projectId: 'test', port: 55432 }).version(),
  ]) await expect(check()).rejects.toThrow(/3\.0\.0 \|\| 3\.1\.0/);
});

it('reports exit status and safe underlying diagnostics without echoing credentials', async () => {
  const cli = new SupabaseCli(async () => ({ code: 1, stdout: JSON.stringify({ error: { code: 'FunctionsApiTransportError', message: 'fetch failed Authorization: Bearer PRIVATE' } }), stderr: 'connect ECONNREFUSED password=PRIVATE' }), '/isolated', 'abcdefghijklmnopqrst');
  await expect(cli.deployFunction()).rejects.toThrow(/function deployment.*subprocess.*exit=1.*ECONNREFUSED/);
  await expect(cli.deployFunction()).rejects.not.toThrow(/PRIVATE/);
});
it.each(['broken', '{}'])('identifies JSON versus target validation for %s', async (stdout) => {
  const cli = new SupabaseCli(async () => ({ code: 0, stdout, stderr: '' }), '/isolated', 'abcdefghijklmnopqrst');
  await expect(cli.deployFunction()).rejects.toThrow(stdout === 'broken' ? /function deployment.*JSON parsing/ : /function deployment.*target validation/);
});

it('withholds arbitrary credentials and emits only fixed diagnostic vocabulary', async () => {
  const { safeProcessOutput } = await import('../../packages/cli/src/lib/deployment-diagnostic.ts');
  const secrets = ['sbp_private', 'sb_secret_private', 'eyJhbGciOiJIUzI1NiJ9.payload.signature', 'Basic dXNlcjpwYXNz', 'postgres://user:private@host/db', 'password="private with spaces"', '\u001b[31mPRIVATE'];
  const message = safeProcessOutput(JSON.stringify({error:{message:secrets.join('\n')}}), secrets.join('\n'));
  for (const secret of secrets) expect(message).not.toContain(secret);
  expect(message).toContain('unrecognized diagnostic');
});

it('raw opt-in logging preserves both streams exactly without changing subprocess results', async () => {
  const { rawDeploymentLog } = await import('../../packages/cli/src/lib/raw-deployment-log.ts');
  const { readFileSync } = await import('node:fs');
  const root = project(); roots.push(root);
  const result = {code:null, stdout:'original\nstdout\u001b[31m', stderr:'original\nstderr SECRET', termination:'ABORT_ERR'};
  const log = rawDeploymentLog(join(root,'raw.jsonl'), async () => result);
  try { expect(await log.run(['functions','deploy','supagame'],root)).toBe(result); }
  finally { log.close(); }
  const records = readFileSync(join(root,'raw.jsonl'),'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records[0]).toMatchObject({event:'start',args:['functions','deploy','supagame'],cwd:root});
  expect(records[1]).toMatchObject({event:'result',...result});
});

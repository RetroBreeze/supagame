// Real CLI processes; Management API responses below are synthetic, not hosted proof.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SupabaseCli, type ProcessRunner } from '../../packages/cli/src/lib/supabase-cli.ts';
import { DoctorInspector } from '../../packages/cli/src/lib/doctor-inspect.ts';
import { HostedConfiguration } from '../../packages/cli/src/lib/hosted-config.ts';

test('actual supported CLI capabilities, JSON serialization and unattended consent', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'supagame-cli-compatibility-'));
  const ref = 'abcdefghijklmnopqrst';
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') {
      res.writeHead(405).end('{}');
      return;
    }
    const project = { id: ref, ref, organization_id: 'fixture', organization_slug: 'fixture', name: 'fixture', region: 'us-east-1', created_at: '2026-01-01T00:00:00Z', status: 'ACTIVE_HEALTHY', database: { host: '127.0.0.1', version: '15.1', postgres_engine: '15', release_channel: 'ga' } };
    const responses: Record<string, unknown> = {
      '/v1/projects': [project],
      [`/v1/projects/${ref}`]: project,
      [`/v1/projects/${ref}/functions`]: [{ id: '11111111-1111-4111-8111-111111111111', slug: 'supagame', name: 'supagame', status: 'ACTIVE', version: 2, created_at: 1687423025152, updated_at: 1687423025152, verify_jwt: false }],
      [`/v1/projects/${ref}/secrets`]: [],
      [`/v2/projects/${ref}/config`]: { data: { type: 'project_config', id: ref, attributes: { auth: { external_anonymous_users_enabled: false, disable_signup: false } } } },
    };
    const body = responses[req.url ?? ''];
    if (body === undefined) res.writeHead(404).end('{}');
    else res.end(JSON.stringify(body));
  });
  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const profile = join(root, 'profile.yaml');
  writeFileSync(profile, `name: compatibility-fixture\napi_url: ${apiUrl}\ndashboard_url: ${apiUrl}\nproject_host: localhost\npooler_host: localhost\n`);
  mkdirSync(join(root, 'supabase'));
  writeFileSync(join(root, 'supabase/config.toml'), 'project_id = "compatibility-fixture"\n');
  const run: ProcessRunner = (args, cwd) => new Promise((done) => {
    const child = execFile(resolve('node_modules/.bin/supabase'), [...args, '--profile', profile], {
      cwd, encoding: 'utf8', timeout: 20_000,
      // No ambient login, target, consent or database password can enter this fixture.
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, SUPABASE_ACCESS_TOKEN: `sbp_${'0'.repeat(40)}`, SUPABASE_YES: 'false' },
    }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }));
    child.stdin?.end();
  });
  mkdirSync(join(root, 'supabase/.temp'));
  writeFileSync(join(root, 'supabase/.temp/project-ref'), 'zzzzzzzzzzzzzzzzzzzz');
  const cli = new SupabaseCli(run, root, ref);
  await cli.checkVersion();
  await cli.checkCapabilities();
  const version = (await run(['--version'], root)).stdout.trim();
  if (process.env.SUPABASE_TEST_VERSION) assert.equal(version, process.env.SUPABASE_TEST_VERSION);
  t.diagnostic(`Actual Supabase CLI ${version}; Node ${process.version}`);
  assert.deepEqual(await cli.functionInfo(), { version: 2, status: 'ACTIVE', verifyJwt: false, hash: null });
  const hosted = new HostedConfiguration(run, ref);
  try {
    assert.deepEqual(await hosted.secret(), { originDigest: null, projectName: null });
    assert.equal((await hosted.auth()).anonymous, false);
  } finally { hosted.remove(); }
  const wrongTarget = new DoctorInspector(run, root, { ref: 'zzzzzzzzzzzzzzzzzzzz', projectId: 'fixture', port: 54322 });
  await assert.rejects(wrongTarget.json(['functions', 'list']));
  for (const command of [['functions', 'deploy', 'supagame'], ['db', 'query', 'select 1', '--agent=no']]) {
    const declined = await run([...command, `--remote=${ref}`, '--workdir', root, '--output-format', 'json'], root);
    assert.notEqual(declined.code, 0);
    assert.match(declined.stdout + declined.stderr, /--yes|confirm|non.interactive|consent/i);
  }
  assert.ok(requests.some((r) => r.endsWith('/functions')));
  assert.ok(requests.some((r) => r.endsWith('/secrets')));
  assert.ok(requests.every((r) => r.startsWith('GET ')), 'No Management API mutation may be attempted.');
});

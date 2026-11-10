import { readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cli, initialized, manifest, project, put, ref, snapshot } from './project-fixture.ts';
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function installed() {
  const root = project();
  roots.push(root);
  initialized(root);
  const result = cli(root, 'add', 'leaderboards');
  expect(result.status, result.stderr).toBe(0);
  return root;
}
it('doctor checks healthy local files without credentials or filesystem changes', () => {
  const root = installed(), before = snapshot(root);
  const result = cli(root, 'doctor');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('HEALTHY');
  expect(result.stdout).toContain(ref);
  expect(result.stdout).toContain('core 0.1.2');
  expect(result.stdout).toContain('leaderboards 0.1.2');
  expect(result.stdout).toContain('CANNOT VERIFY');
  expect(result.stdout).toContain('--local');
  expect(snapshot(root)).toEqual(before);
});
it.each(['missing', 'invalid'])('doctor reports %s manifest and preserves files', (kind) => {
  const root = installed();
  if (kind === 'missing') unlinkSync(join(root, 'supagame.config.json'));
  else put(root, 'supagame.config.json', '{bad json');
  const before = snapshot(root);
  const result = cli(root, 'doctor');
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/ERROR.*manifest/i);
  expect(snapshot(root)).toEqual(before);
});
it.each([
  'supabase/migrations/20261108000100_core_players.sql',
  'supabase/functions/supagame/index.ts',
])('doctor reports missing %s without restoring it', (path) => {
  const root = installed();
  unlinkSync(join(root, path));
  const before = snapshot(root);
  const result = cli(root, 'doctor');
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(path);
  expect(result.stdout).toMatch(/restore/i);
  expect(snapshot(root)).toEqual(before);
});
it('doctor warns about disabled anonymous auth and detects incompatible function configuration', () => {
  const root = installed();
  const file = 'supabase/config.toml';
  put(
    root,
    file,
    readFileSync(join(root, file), 'utf8').replace(
      'enable_anonymous_sign_ins = true',
      'enable_anonymous_sign_ins = false',
    ),
  );
  expect(cli(root, 'doctor').stdout).toMatch(/WARNING.*anonymous/i);
  put(
    root,
    file,
    readFileSync(join(root, file), 'utf8').replace('verify_jwt = false', 'verify_jwt = true'),
  );
  const result = cli(root, 'doctor');
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/ERROR.*function/i);
});
it('doctor rejects incompatible versions and mismatched targets before remote inspection', () => {
  const root = installed();
  const mismatch = cli(root, 'doctor', '--remote', '--project-ref', 'zzzzzzzzzzzzzzzzzzzz');
  expect(mismatch.status).toBe(1);
  expect(mismatch.stdout).toMatch(/mismatch/i);
  const value = manifest(root);
  value.modules.core = '9.0.0';
  put(root, 'supagame.config.json', JSON.stringify(value));
  expect(cli(root, 'doctor').stdout).toMatch(/ERROR.*incompatible/i);
});
it('upgrade reports no available upgrade, preserving all bytes and mtimes on repeat and dry-run', () => {
  const root = installed();
  put(root, 'notes.txt', 'unrelated');
  const before = snapshot(root);
  for (const args of [[], [], ['--dry-run']]) {
    const result = cli(root, 'upgrade', ...args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no upgrade available/i);
    expect(snapshot(root)).toEqual(before);
  }
});
it('upgrade refuses modified files and unknown versions without changing anything', () => {
  const root = installed();
  put(root, 'supabase/functions/supagame/index.ts', '// my changes');
  const before = snapshot(root);
  expect(cli(root, 'upgrade').status).toBe(1);
  expect(snapshot(root)).toEqual(before);
  const value = manifest(root);
  value.modules.leaderboards = '0.0.1';
  put(root, 'supagame.config.json', JSON.stringify(value));
  expect(cli(root, 'upgrade').stderr).toMatch(/incompatible|unknown/i);
});
it('doctor detects local config overrides rather than claiming effective configuration is verified', () => {
  const root = installed();
  put(root, 'supabase/config.json', '{}');
  const before = snapshot(root);
  expect(cli(root, 'doctor').stdout).toMatch(/WARNING.*config.json/i);
  expect(snapshot(root)).toEqual(before);
});

// Future releases are fixtures passed directly to the staging engine, never CLI input.
import { upgrade } from '../../packages/cli/src/commands/upgrade.ts';
import { currentInventory, validateInventory } from '../../packages/cli/src/lib/versions.ts';
import type { Inventory, ModuleRelease } from '../../packages/cli/src/lib/versions.ts';
import { templateFiles } from '../../packages/cli/src/lib/templates.ts';
import { doctor, doctorExitCode } from '../../packages/cli/src/commands/doctor.ts';
import { securityChecks } from '../../packages/cli/src/lib/doctor-security.ts';
import type { ProcessRunner } from '../../packages/cli/src/lib/supabase-cli.ts';
import { vi } from 'vitest';

function future(): Inventory {
  const current = currentInventory(templateFiles()).filter(r => ['core','leaderboards'].includes(r.module) && r.version === '0.1.2').map(r => ({...r,previous:undefined}));
  const core = current.find((r) => r.module === 'core')!,
    boards = current.find((r) => r.module === 'leaderboards')!;
  return [...current, {
    ...core,
    version: '0.2.0',
    previous: '0.1.2',
    migrations: [...core.migrations, {
      path: 'supabase/migrations/20261109000100_core_fixture.sql',
      content: Buffer.from('-- test fixture only\nselect 1;\n'),
    }],
  }, {
    ...boards,
    version: '0.2.0',
    previous: '0.1.2',
    requiresCore: '0.2.0',
    migrations: [...boards.migrations, {
      path: 'supabase/migrations/20261109000200_boards_fixture.sql',
      content: Buffer.from('-- test fixture only\nselect 2;\n'),
    }],
    assets: boards.assets.map((f) =>
      f.path.endsWith('/index.ts')
        ? { ...f, content: Buffer.concat([f.content, Buffer.from('\n// future fixture\n')]) }
        : f
    ),
  }];
}
it('stages fixture-only forward migrations and clean assets transactionally, then repeats without changes', () => {
  const root = installed(), before = snapshot(root), inventory = future();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    upgrade({ workdir: root, dryRun: true }, inventory);
    expect(snapshot(root)).toEqual(before);
    upgrade({ workdir: root }, inventory);
    expect(manifest(root).modules).toEqual({ core: '0.2.0', leaderboards: '0.2.0' });
    for (const [path, file] of Object.entries(before)) {
      if (path.includes('/migrations/')) expect(snapshot(root)[path]).toEqual(file);
    }
    const after = snapshot(root);
    upgrade({ workdir: root }, inventory);
    expect(snapshot(root)).toEqual(after);
  } finally {
    log.mockRestore();
  }
});
it('future upgrades preserve modified assets and conflicting new SQL without partial writes', () => {
  const root = installed();
  put(root, 'supabase/functions/supagame/index.ts', '// custom');
  const before = snapshot(root);
  expect(() => upgrade({ workdir: root }, future())).toThrow(/conflict/i);
  expect(snapshot(root)).toEqual(before);
});
it('rejects release histories that rewrite applied SQL, remove assets or go backward', () => {
  const inventory = future();
  const release = inventory[2]!;
  expect(() =>
    validateInventory([...inventory.slice(0, 2), {
      ...release,
      migrations: release.migrations.map((f, i) =>
        i === 0 ? { ...f, content: Buffer.from('select 9;') } : f
      ),
    }])
  ).toThrow(/rewrite/i);
  expect(() => validateInventory([...inventory.slice(0, 3), { ...inventory[3]!, assets: [] }]))
    .toThrow(/remove/i);
  expect(() => validateInventory([...inventory.slice(0, 2), { ...release, version: '0.0.9' }]))
    .toThrow(/forward/i);
});
it('rejects incompatible starting module pairs even if the latest release pair is compatible', () => {
  const root = installed();
  const value = manifest(root);
  value.modules.core = '0.2.0';
  put(root, 'supagame.config.json', JSON.stringify(value));
  const core = future()[2]!;
  for (const f of core.migrations) put(root, f.path, f.content.toString());
  const before = snapshot(root);
  expect(() => upgrade({ workdir: root }, future())).toThrow(/incompatible/i);
  expect(snapshot(root)).toEqual(before);
});
it('rejects new migration-version collisions between modules before staging', () => {
  const root = installed(), inventory = future();
  const last = inventory[3]!;
  const broken: ModuleRelease = {
    ...last,
    migrations: [...last.migrations.slice(0, -1), {
      path: 'supabase/migrations/20261109000100_collision.sql',
      content: Buffer.from('select 2;'),
    }],
  };
  const before = snapshot(root);
  expect(() => upgrade({ workdir: root }, [...inventory.slice(0, 3), broken])).toThrow(
    /collision|version/i,
  );
  expect(snapshot(root)).toEqual(before);
});
it('recovers pre-staged identical future files without rewriting old migrations', () => {
  const root = installed(), inventory = future();
  const last = inventory[3]!;
  for (const f of [...last.migrations, ...last.assets]) put(root, f.path, f.content.toString());
  const sqlBefore = snapshot(root)['supabase/migrations/20261109000200_boards_fixture.sql'];
  upgrade({ workdir: root }, inventory);
  expect(snapshot(root)['supabase/migrations/20261109000200_boards_fixture.sql']).toEqual(
    sqlBefore,
  );
  expect(manifest(root).modules.leaderboards).toBe('0.2.0');
});

function remoteFixture() {
  const root = installed(), calls: string[][] = [], logs: string[] = [];
  let oldSchema = false, drift = false, malformed = false;
  let unreachable = false,
    wrongTarget = false,
    localTarget = false,
    missingFunction = false,
    disabledAuth = false,
    unsafe = false,
    pending = false;
  const run: ProcessRunner = async (args, cwd) => {
    calls.push([...args]);
    expect(cwd).not.toBe(root);
    expect(args).not.toContain('--yes');
    expect(args).not.toContain('--prune');
    if (args[0] === '--version') return { code: 0, stdout: '3.0.0', stderr: '' };
    expect(args).toContain(`--remote=${ref}`);
    if (unreachable) return { code: 1, stdout: '', stderr: 'SECRET_TOKEN' };
    const target = {
      kind: localTarget ? 'local' : 'linked',
      project_ref: wrongTarget ? 'zzzzzzzzzzzzzzzzzzzz' : ref,
    };
    let value: unknown;
    if (args[0] === 'migration') {
      value = {
        target,
        migrations: readdirSync(join(cwd, 'supabase/migrations')).sort().map((name) => ({
          local: name.slice(0, 14),
          remote: pending || (oldSchema && name.startsWith('20261109')) ? '' : name.slice(0, 14),
        })),
      };
    } else if (args[0] === 'db' && args[1] === 'query') {
      expect(args).toContain('--read-only');
      value = securityChecks(['core', 'leaderboards']).map((c) => ({
        check: c.id,
        ok: !(unsafe && c.id === 'writes:anon:game_best_scores'),
      }));
      if (malformed && Array.isArray(value)) value.pop();
    } else if (args[0] === 'config' && args[1] === 'diff') {
      value = {
        target,
        schema_version: drift ? 2 : 1,
        scope: { present: ['auth'], missing: [] },
        masked: [],
        unmanaged: [],
        changes: disabledAuth
          ? [{ path: ['auth', 'enable_anonymous_sign_ins'], class: 'update', declared: true, local: true, remote: false }]
          : [],
      };
    } else if (args[0] === 'secrets' && args[1] === 'list') {
      value = { target, secrets: [] };
    } else if (args[0] === 'functions' && args[1] === 'list') {
      value = {
        target,
        functions: missingFunction ? [] : [{
          slug: 'supagame',
          status: 'ACTIVE',
          verify_jwt: false,
          version: drift ? 2 : 1,
          ezbr_sha256: 'a'.repeat(64),
        }],
      };
    } else throw new Error('Unexpected/non-read-only command');
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  return {
    root,
    calls,
    logs,
    run,
    options: { workdir: root, remote: true, projectRef: ref },
    deps: { run, log: (s: string) => logs.push(s), inventory: currentInventory(templateFiles()).filter(r => ['core','leaderboards'].includes(r.module) && r.version === '0.1.2').map((r): ModuleRelease => ({...r,previous:undefined})) },
    set: (key: string) => {
      if (key === 'unreachable') unreachable = true;
      if (key === 'wrong') wrongTarget = true;
      if (key === 'local') localTarget = true;
      if (key === 'missing') missingFunction = true;
      if (key === 'auth') disabledAuth = true;
      if (key === 'unsafe') unsafe = true;
      if (key === 'pending') pending = true;
      if (key === 'oldSchema') oldSchema = true;
      if (key === 'drift') drift = true;
      if (key === 'malformed') malformed = true;
    },
  };
}
it('remote doctor uses only explicit read-only operations, distinguishes verified metadata from unverified runtime, and leaves project untouched', async () => {
  const f = remoteFixture(), before = snapshot(f.root);
  const findings = await doctor(f.options, f.deps);
  expect(findings.filter((f) => f.status === 'error')).toEqual([]);
  expect(findings.some((f) => f.id === 'schema:core' && f.status === 'healthy')).toBe(true);
  expect(findings.some((f) => f.id === 'writes:anon:game_best_scores' && f.status === 'healthy'))
    .toBe(true);
  expect(findings.some((f) => f.id === 'function-content' && f.status === 'cannot verify')).toBe(
    true,
  );
  expect(f.calls.map((a) => a.slice(0, 2))).toEqual([
    ['--version'],
    ['migration', 'list'],
    ['db', 'query'],
    ['config', 'diff'],
    ['secrets', 'list'],
    ['functions', 'list'],
  ]);
  expect(snapshot(f.root)).toEqual(before);
});
it.each(['unreachable', 'wrong', 'local'])(
  'fails closed on remote %s and never queries an unverified target',
  async (kind) => {
    const f = remoteFixture();
    f.set(kind);
    const findings = await doctor(f.options, f.deps);
    expect(doctorExitCode(findings, true)).toBe(2);
    expect(f.calls).toHaveLength(2);
    expect(f.logs.join(' ')).not.toContain('SECRET_TOKEN');
  },
);
it('requires explicit matching remote ref before invoking even the version probe', async () => {
  const f = remoteFixture();
  for (const projectRef of ['', 'zzzzzzzzzzzzzzzzzzzz']) {
    const result = await doctor({ ...f.options, projectRef }, f.deps);
    expect(doctorExitCode(result, true)).toBe(1);
  }
  expect(f.calls).toHaveLength(0);
});
it.each([['auth', 'auth-drift', 'warning'], ['missing', 'function', 'error'], [
  'unsafe',
  'writes:anon:game_best_scores',
  'error',
], ['pending', 'schema:core', 'warning']])('reports remote %s drift', async (kind, id, status) => {
  const f = remoteFixture();
  f.set(kind);
  const result = await doctor(f.options, f.deps);
  expect(result.some((f) => f.id === id && f.status === status)).toBe(true);
});

it('reports the actual known database schema version separately from newer locally staged versions', async () => {
  const f = remoteFixture(), inventory = future();
  upgrade({ workdir: f.root }, inventory);
  f.deps.inventory = [...inventory];
  f.set('oldSchema');
  const findings = await doctor(f.options, f.deps);
  expect(findings.find((f) => f.id === 'schema:core')?.message).toMatch(
    /schema 0.1.2.*expected 0.2.0/,
  );
});
it('reports missing security evidence as cannot verify, never healthy', async () => {
  const f = remoteFixture();
  f.set('malformed');
  const findings = await doctor(f.options, f.deps);
  expect(findings.some((f) => f.id === 'security' && f.status === 'cannot verify')).toBe(true);
  expect(findings.some((f) => f.id.startsWith('writes:'))).toBe(false);
});
it('checks a matching deployment receipt and warns on proven remote function drift', async () => {
  const f = remoteFixture();
  const { deploymentFiles } = await import('../../packages/cli/src/lib/deployment-files.ts');
  put(
    f.root,
    'supabase/.temp/supagame-deploy.json',
    JSON.stringify({
      formatVersion: 1,
      projectRef: ref,
      phase: 'complete',
      attempted: [],
      functionHash: deploymentFiles(f.root, ref).functionHash,
      remoteFunction: { version: 1, status: 'ACTIVE', verifyJwt: false, hash: 'a'.repeat(64) },
    }),
  );
  expect(
    (await doctor(f.options, f.deps)).some((f) =>
      f.id === 'function-content' && f.status === 'healthy'
    ),
  ).toBe(true);
  f.set('drift');
  expect(
    (await doctor(f.options, f.deps)).some((f) =>
      f.id === 'function-content' && f.status === 'warning'
    ),
  ).toBe(true);
});
it('reports unsafe configuration paths as diagnostic errors and never follows or modifies them', () => {
  const root = installed();
  symlinkSync(join(root, 'supagame.config.json'), join(root, 'supabase/config.json'));
  const before = snapshot(root);
  const result = cli(root, 'doctor');
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/ERROR.*symlink/i);
  expect(snapshot(root)).toEqual(before);
});
it('uses a distinct exit code when requested live evidence is incomplete', () => {
  expect(
    doctorExitCode([{
      scope: 'remote',
      id: 'function-content',
      status: 'cannot verify',
      message: 'No matching receipt.',
    }], true),
  ).toBe(2);
  expect(
    doctorExitCode([{
      scope: 'local',
      id: 'anonymous-auth',
      status: 'warning',
      message: 'Disabled.',
    }], false),
  ).toBe(0);
});
it.each(['missing', 'contradictory'])(
  'does not infer schema health from %s migration-list evidence',
  async (kind) => {
    const f = remoteFixture();
    const run = f.deps.run;
    f.deps.run = async (args, cwd) => {
      const result = await run(args, cwd);
      if (args[0] === 'migration') {
        const data = JSON.parse(result.stdout);
        if (kind === 'missing') data.migrations.pop();
        else data.migrations[0].local = '20261108000200';
        return { ...result, stdout: JSON.stringify(data) };
      }
      return result;
    };
    const findings = await doctor(f.options, f.deps);
    expect(findings.some((f) => f.id === 'connection' && f.status === 'cannot verify')).toBe(true);
    expect(findings.some((f) => f.id.startsWith('schema:') && f.status === 'healthy')).toBe(false);
    expect(f.calls).toHaveLength(2);
  },
);

it('doctor identifies absent/mismatched origin configuration and disabled Auth as action required', async () => {
  const f = remoteFixture();
  expect(cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173').status).toBe(0);
  f.set('auth');
  const findings = await doctor(f.options, f.deps);
  expect(findings.find(d => d.scope === 'remote' && d.id === 'origins')?.status).toBe('action required');
  expect(findings.find(d => d.scope === 'remote' && d.id === 'anonymous-auth')?.status).toBe('action required');
  expect(doctorExitCode(findings, true)).toBe(1);
});

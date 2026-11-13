import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { realtimePrerequisites } from '../../packages/cli/src/lib/realtime-prerequisites.ts';
import { digest } from '../../packages/cli/src/lib/deployment-files.ts';
import { deploy } from '../../packages/cli/src/commands/deploy.ts';
import type { DeployDependencies } from '../../packages/cli/src/commands/deploy.ts';
import type { ProcessRunner } from '../../packages/cli/src/lib/supabase-cli.ts';
import { cli, initialized, project, put, ref, snapshot } from './project-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
function fixture() {
  const root = project();
  roots.push(root);
  initialized(root);
  expect(cli(root, 'add', 'leaderboards').status).toBe(0);
  put(root, 'supabase/migrations/20261109000100_my_app.sql', 'select 1;\n');
  const calls: { args: readonly string[]; cwd: string }[] = [],
    logs: string[] = [];
  const applied = new Set<string>();
  let remoteFunction: Record<string, unknown> | null = null;
  let omitHash = false;
  let realtimeReady = true;
  let anonymous = true, secret: string | null = null, configFailure = false;
  let failure: 'db' | 'partial' | 'function' | 'interrupt' | undefined;
  let badPreview = false,
    badTarget = false,
    badVersion = false,
    unavailable = false;
  const run: ProcessRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (unavailable) throw new Error('secret credential from process error');
    if (args[0] === '--version') {
      return { code: 0, stdout: badVersion ? '2.0.0' : '3.0.0\n', stderr: '' };
    }
    if (args.at(-1) === '--help') return { code: 0, stdout: '--remote[=<ref>] --workdir string --output-format choice --include-all --skip-vault --dry-run --yes --env-file string --read-only --agent choice --output choice'.replaceAll(' --', '\n--'), stderr: '' };
    expect(args).toContain(`--remote=${ref}`);
    const target = {
      kind: 'linked',
      project_ref: badTarget ? 'zzzzzzzzzzzzzzzzzzzz' : ref,
    };
    const names = existsSync(join(cwd, 'supabase/migrations')) ? readdirSync(join(cwd, 'supabase/migrations')).sort() : [];
    const pending = names.filter((name) => !applied.has(name.slice(0, 14)));
    const json = (data: object) => ({
      code: 0,
      stdout: JSON.stringify({ ...data, target }),
      stderr: '',
    });
    if (args[0] === 'config') {
      if (args[1] === 'push') { if (configFailure) return { code: 1, stdout: '', stderr: 'SECRET credential' }; anonymous = true; return json({}); }
      return json({ schema_version: 1, scope: { present: ['auth', 'realtime'] }, changes: anonymous ? [] : [{ path: ['auth', 'enable_anonymous_sign_ins'], class: 'update', declared: true, local: true, remote: false }], masked: [], unmanaged: [] });
    }
    if (args[0] === 'secrets') {
      if (args[1] === 'set') {
        if (configFailure) return { code: 1, stdout: '', stderr: 'SECRET credential' };
        const value = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8').trim().slice("SG_ALLOWED_ORIGINS='".length, -1);
        secret = digest(value);
      }
      return json({ secrets: secret ? [{ name: 'SG_ALLOWED_ORIGINS', value: secret }] : [] });
    }
    if (args[0] === 'migration') {
      return json({
        migrations: [
          ...new Set([...names.map((n) => n.slice(0, 14)), ...applied]),
        ].sort().map((version) => ({
          local: names.some((n) => n.startsWith(version)) ? version : '',
          remote: applied.has(version) ? version : '',
          time: '',
        })),
      });
    }
    if (args[0] === 'db' && args[1] === 'query') return { code: 0, stdout: JSON.stringify(realtimePrerequisites().map(c => ({ check: c.id, ok: realtimeReady }))), stderr: '' };
    if (args[0] === 'db') {
      expect(args).toContain('--skip-vault');
      expect(args).toContain('--include-all');
      if (args.includes('--dry-run')) {
        return json({
          dryRun: true,
          migrations: badPreview ? ['unknown.sql'] : pending,
          roles: [],
          seeds: [],
        });
      }
      expect(args).toContain('--yes');
      if (failure === 'interrupt') throw new Error('SIGINT');
      if (failure === 'partial') applied.add(pending[0]!.slice(0, 14));
      if (failure === 'db' || failure === 'partial') {
        return { code: 1, stdout: '', stderr: 'SECRET SQL credential' };
      }
      pending.forEach((name) => applied.add(name.slice(0, 14)));
      return json({ dryRun: false, migrations: pending, roles: [], seeds: [] });
    }
    if (args[0] === 'functions' && args[1] === 'list') {
      return json({ functions: remoteFunction ? [remoteFunction] : [] });
    }
    if (args[0] === 'functions' && args[1] === 'deploy') {
      expect(args[2]).toBe('supagame');
      expect(args).toContain('--yes');
      if (failure === 'function') {
        return { code: 1, stdout: '', stderr: 'SECRET token' };
      }
      remoteFunction = {
        slug: 'supagame',
        status: 'ACTIVE',
        version: Number(remoteFunction?.version ?? 0) + 1,
        verify_jwt: false,
        ...(omitHash ? {} : { ezbr_sha256: 'a'.repeat(64) }),
      };
      return json({ project_ref: ref, functions: ['supagame'] });
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const confirm = vi.fn(async () => `deploy ${ref}`);
  const deps: DeployDependencies = {
    run,
    confirm,
    interactive: true,
    log: (line) => logs.push(line),
  };
  const options = { workdir: root, projectRef: ref };
  const mutations = () =>
    calls.filter(({ args }) => !args.includes('--help') && (
      (args[0] === 'db' && args[1] === 'push' && !args.includes('--dry-run')) ||
      (args[0] === 'functions' && args[1] === 'deploy') ||
      (args[0] === 'config' && args[1] === 'push') ||
      (args[0] === 'secrets' && args[1] === 'set')
    ));
  return {
    root,
    realtimeUnavailable: () => { realtimeReady = false; },
    hosted: (a: boolean, s: string | null) => { anonymous = a; secret = s; },
    configFail: (v: boolean) => { configFailure = v; },
    calls,
    applied,
    logs,
    deps,
    options,
    mutations,
    confirm,
    fail: (value: typeof failure) => {
      failure = value;
    },
    corruptPreview: () => {
      badPreview = true;
    },
    wrongTarget: () => {
      badTarget = true;
    },
    unsupportedVersion: () => {
      badVersion = true;
    },
    unavailable: () => {
      unavailable = true;
    },
    omitHash: () => {
      omitHash = true;
    },
    driftFunction: () => {
      remoteFunction = { ...remoteFunction, version: 99 };
    },
  };
}
it('previews all migrations including unrelated SQL before explicit interactive consent', async () => {
  const f = fixture();
  const before = readFileSync(join(f.root, 'supabase/config.toml'));
  f.confirm.mockImplementation(async () => {
    expect(f.mutations()).toHaveLength(0);
    expect(f.logs.join('\n')).toContain(ref);
    expect(f.logs.join('\n')).toMatch(/unrelated.*20261109000100_my_app.sql/i);
    expect(f.logs.join('\n')).toContain('supagame');
    return `deploy ${ref}`;
  });
  await deploy(f.options, f.deps);
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.mutations()).toHaveLength(2);
  expect(f.mutations()[0]!.args.slice(0, 2)).toEqual(['db', 'push']);
  expect(f.mutations()[1]!.args.slice(0, 3)).toEqual([
    'functions',
    'deploy',
    'supagame',
  ]);
  expect(f.calls.flatMap((c) => c.args)).not.toContain('--prune');
  expect(f.calls.every((c) => c.cwd !== f.root)).toBe(true);
  expect(readFileSync(join(f.root, 'supabase/config.toml'))).toEqual(before);
  expect(f.logs.join('\n')).toMatch(/deployment complete/i);
});
it.each([undefined, '', 'wrong', 'zzzzzzzzzzzzzzzzzzzz'])(
  'rejects missing/mismatched destination %s before any Supabase call',
  async (projectRef) => {
    const f = fixture();
    await expect(
      deploy({
        workdir: f.root,
        ...(projectRef === undefined ? {} : { projectRef }),
      }, f.deps),
    ).rejects.toThrow(/project|reference/i);
    expect(f.calls).toHaveLength(0);
  },
);
it('checks local linked metadata too', async () => {
  const f = fixture();
  put(f.root, 'supabase/.temp/project-ref', 'zzzzzzzzzzzzzzzzzzzz');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/mismatch/i);
  expect(f.calls).toHaveLength(0);
});
it.each(['no', 'yes', '', `deploy zzzzzzzzzzzzzzzzzzzz`])(
  'declined/ambiguous confirmation %s makes zero mutation calls',
  async (answer) => {
    const f = fixture();
    f.confirm.mockResolvedValue(answer);
    await expect(deploy(f.options, f.deps)).rejects.toThrow(/declined|cancel/i);
    expect(f.mutations()).toHaveLength(0);
  },
);
it('noninteractive execution requires the deliberate flag, ignoring environment consent', async () => {
  const f = fixture();
  f.deps.interactive = false;
  vi.stubEnv('SUPABASE_YES', 'true');
  vi.stubEnv('CI', 'true');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/allow-remote/);
  expect(f.calls).toHaveLength(0);
  await deploy({ ...f.options, allowRemote: true }, f.deps);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.mutations()).toHaveLength(2);
  expect(f.logs.join('\n')).toMatch(
    /noninteractive authorization.*--allow-remote/i,
  );
});
it('dry-run previews through read-only calls and preserves project bytes', async () => {
  const f = fixture();
  const before = snapshot(f.root);
  f.deps.interactive = false;
  await deploy({ ...f.options, dryRun: true }, f.deps);
  expect(f.mutations()).toHaveLength(0);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(snapshot(f.root)).toEqual(before);
});
it.each(
  [
    'corruptPreview',
    'wrongTarget',
    'unsupportedVersion',
    'unavailable',
  ] as const,
)('fails closed for %s without leaking process output', async (kind) => {
  const f = fixture();
  f[kind]();
  await expect(deploy(f.options, f.deps)).rejects.toThrow();
  expect(f.mutations()).toHaveLength(0);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.logs.join(' ')).not.toContain('SECRET');
});
it('rejects remote migration history not present locally', async () => {
  const f = fixture();
  f.applied.add('20250101000000');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(
    /history|missing|remote/i,
  );
  expect(f.mutations()).toHaveLength(0);
});
it('rejects files changed during confirmation', async () => {
  const f = fixture();
  f.confirm.mockImplementation(async () => {
    put(f.root, 'supabase/migrations/20261109000100_my_app.sql', 'select 2;');
    return `deploy ${ref}`;
  });
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/changed/i);
  expect(f.mutations()).toHaveLength(0);
});
it('rejects new remote changes during confirmation', async () => {
  const f = fixture();
  f.confirm.mockImplementation(async () => {
    f.applied.add('20261109000100');
    return `deploy ${ref}`;
  });
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/changed/i);
  expect(f.mutations()).toHaveLength(0);
});
it('isolates config overrides, seeds, secrets and unrelated functions', async () => {
  const f = fixture();
  put(f.root, '.env', 'SUPABASE_PROJECT_ID=zzzzzzzzzzzzzzzzzzzz');
  put(f.root, 'supabase/config.jsonc', '{"db":{"seed":{"enabled":true}}}');
  put(f.root, 'supabase/config.json', '{"db":{"seed":{"enabled":true}}}');
  put(f.root, 'supabase/functions/other/index.ts', 'throw new Error();');
  put(f.root, 'supabase/seed.sql', 'select 1;');
  const run = f.deps.run;
  f.deps.run = async (args, cwd) => {
    const files = Object.keys(snapshot(cwd));
    expect(files).not.toContain('.env');
    expect(files).not.toContain('supabase/config.json');
    expect(files).not.toContain('supabase/config.jsonc');
    expect(files).not.toContain('supabase/seed.sql');
    expect(files.some((n) => n.includes('/other/'))).toBe(false);
    return run(args, cwd);
  };
  await deploy(f.options, f.deps);
});
it('rejects symlink migrations and modified SDK function files', async () => {
  const f = fixture();
  symlinkSync(
    join(f.root, 'supagame.config.json'),
    join(f.root, 'supabase/migrations/20261110000000_bad.sql'),
  );
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/symlink/i);
  expect(f.calls).toHaveLength(0);
  rmSync(join(f.root, 'supabase/migrations/20261110000000_bad.sql'));
  put(
    f.root,
    'supabase/functions/supagame/index.ts',
    'import "../../../outside.ts";',
  );
  await expect(deploy(f.options, f.deps)).rejects.toThrow(
    /modified|conflict|template/i,
  );
  expect(f.calls).toHaveLength(0);
});
it.each(['db', 'partial', 'interrupt'] as const)(
  'records and reconciles %s failure, blocks uncertain replay and never deploys functions',
  async (failure) => {
    const f = fixture();
    f.fail(failure);
    await expect(deploy(f.options, f.deps)).rejects.toThrow(
      /database.*(failed|uncertain)/i,
    );
    expect(f.mutations()).toHaveLength(1);
    expect(f.logs.join('\n')).toMatch(/applied|remaining/i);
    expect(f.logs.join('\n')).not.toContain('SECRET');
    f.fail(undefined);
    const count = f.calls.length;
    await expect(deploy({ ...f.options, allowRemote: true }, f.deps)).rejects
      .toThrow(/inspect|reconcile|uncertain/i);
    expect(f.mutations()).toHaveLength(1);
    expect(f.calls.length).toBeGreaterThan(count);
  },
);
it('function failure preserves successful database progress; a new attempt previews and authorizes only the remaining work', async () => {
  const f = fixture();
  f.fail('function');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/function.*failed/i);
  expect(f.applied.size).toBe(6);
  f.fail(undefined);
  await deploy(f.options, f.deps);
  expect(f.confirm).toHaveBeenCalledTimes(2);
  expect(f.mutations().map((c) => c.args[0])).toEqual([
    'db',
    'functions',
    'functions',
  ]);
});
it('repeated deployment skips verified unchanged functions and migrations, but detects remote function drift', async () => {
  const f = fixture();
  await deploy(f.options, f.deps);
  await deploy(f.options, f.deps);
  expect(f.mutations()).toHaveLength(2);
  expect(f.confirm).toHaveBeenCalledOnce();
  f.driftFunction();
  await deploy(f.options, f.deps);
  expect(f.mutations()).toHaveLength(3);
});

it('does not claim unchanged when the remote content hash is unavailable', async () => {
  const f = fixture();
  f.omitHash();
  await deploy(f.options, f.deps);
  await deploy(f.options, f.deps);
  expect(f.mutations()).toHaveLength(3);
  expect(f.confirm).toHaveBeenCalledTimes(2);
});
it('interrupted confirmation and a pre-existing deployment lock make zero hosted mutations', async () => {
  const f = fixture();
  f.confirm.mockRejectedValue(new Error('interrupted'));
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/cancel/i);
  expect(f.mutations()).toHaveLength(0);
  put(f.root, '.supagame-deploy-lock/owner.json', '{"pid":1}');
  const count = f.calls.length;
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/lock/i);
  expect(f.calls).toHaveLength(count);
});

it('previews and confirms hosted prerequisites with the same deployment', async () => {
  const f = fixture();
  expect(cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173').status).toBe(0);
  f.hosted(false, null);
  f.confirm.mockImplementation(async () => {
    expect(f.mutations()).toHaveLength(0);
    expect(f.logs.join('\n')).toMatch(/Anonymous authentication: enable/);
    expect(f.logs.join('\n')).toMatch(/Browser origins: create/);
    return `deploy ${ref}`;
  });
  await deploy(f.options, f.deps);
  expect(f.mutations().map(c => c.args.slice(0, 2))).toEqual([['config', 'push'], ['secrets', 'set'], ['db', 'push'], ['functions', 'deploy']]);
  const count = f.mutations().length;
  await deploy(f.options, f.deps);
  expect(f.mutations()).toHaveLength(count);
  expect(f.confirm).toHaveBeenCalledOnce();
});
it('previews an unknown existing origin value but blocks replacement unless explicitly requested', async () => {
  const f = fixture(); cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173');
  f.hosted(true, 'b'.repeat(64));
  const before = snapshot(f.root);
  await deploy({ ...f.options, dryRun: true }, f.deps);
  expect(snapshot(f.root)).toEqual(before);
  expect(f.logs.join('\n')).toContain('--replace-origins');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/replace-origins/);
  expect(f.mutations()).toHaveLength(0);
  await deploy({ ...f.options, replaceOrigins: true }, f.deps);
  expect(f.mutations()[0]!.args.slice(0, 2)).toEqual(['secrets', 'set']);
});
it('keeps configuration unchanged when confirmation is declined', async () => {
  const f = fixture(); f.hosted(false, null);
  cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173');
  f.confirm.mockResolvedValue('no');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/declined/);
  expect(f.mutations()).toHaveLength(0);
});
it('rechecks remote configuration after consent', async () => {
  const f = fixture();
  f.confirm.mockImplementation(async () => { f.hosted(false, null); return `deploy ${ref}`; });
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/changed/);
  expect(f.mutations()).toHaveLength(0);
});
it('reports partial configuration failure and safely retries before touching the database', async () => {
  const f = fixture(); f.hosted(true, null); f.configFail(true);
  cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173');
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/configuration.*failed|configuration.*uncertain/i);
  expect(f.mutations().every(c => c.args[0] === 'secrets')).toBe(true);
  expect(f.logs.join('\n')).not.toContain('SECRET');
  f.configFail(false);
  await deploy(f.options, f.deps);
  expect(f.confirm).toHaveBeenCalledTimes(2);
});
it('adds origins after a successful receipt and refuses removing known origins without replacement consent', async () => {
  const f = fixture(); cli(f.root, 'config', 'origins', 'add', 'http://localhost:5173');
  await deploy(f.options, f.deps);
  cli(f.root, 'config', 'origins', 'add', 'https://game.test');
  await deploy(f.options, f.deps);
  expect(f.mutations().filter(c => c.args[0] === 'secrets')).toHaveLength(2);
  const manifest = JSON.parse(readFileSync(join(f.root, 'supagame.config.json'), 'utf8'));
  manifest.origins = ['https://game.test']; put(f.root, 'supagame.config.json', JSON.stringify(manifest));
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/replace-origins/);
});

it('blocks Live Leaderboards deployment when the target lacks database Broadcast prerequisites', async () => {
  const f = fixture(); cli(f.root, 'add', 'live-leaderboards'); f.realtimeUnavailable();
  await deploy({ ...f.options, dryRun: true }, f.deps);
  expect(f.logs.join('\n')).toMatch(/ACTION REQUIRED.*Realtime/);
  await expect(deploy(f.options, f.deps)).rejects.toThrow(/Realtime prerequisites/);
  expect(f.mutations()).toHaveLength(0);
});
it('explains initialization when an explicit target has no manifest', async () => {
  const root = project(); roots.push(root);
  const run = vi.fn();
  await expect(deploy({ workdir: root, projectRef: ref, dryRun: true }, { run, interactive: false, confirm: vi.fn(), log: vi.fn() })).rejects.toThrow(/init/);
  expect(run).not.toHaveBeenCalled();
});

it.each(['--remote', '--workdir', '--output-format', '--yes', '--dry-run', '--include-all', '--skip-vault', '--env-file'])('refuses deployment before any mutation if required flag %s is missing or renamed', async (flag) => {
  const f = fixture();
  const original = f.deps.run;
  f.deps.run = async (args, cwd) => {
    const result = await original(args, cwd);
    if (args.at(-1) === '--help') return { ...result, stdout: result.stdout.replaceAll(flag, '--incompatible') };
    return result;
  };
  await expect(deploy({ ...f.options, allowRemote: true }, f.deps)).rejects.toThrow(/required flag|capabilit/i);
  expect(f.mutations()).toHaveLength(0);
  expect(f.confirm).not.toHaveBeenCalled();
});

it.each([1, null])('fails closed when capability inspection fails or is interrupted (%s)', async (code) => {
  const f = fixture();
  const original = f.deps.run;
  f.deps.run = (args, cwd) => args.at(-1) === '--help'
    ? Promise.resolve({ code, stdout: 'SECRET diagnostic', stderr: 'SECRET credential' }) : original(args, cwd);
  await expect(deploy({ ...f.options, allowRemote: true }, f.deps)).rejects.toThrow(/capabilit/);
  expect(f.mutations()).toHaveLength(0);
});

it.each(['migration list', 'db push', 'functions list', 'config diff', 'secrets list'].flatMap((command) =>
  ['invalid-json', 'null', 'changed-schema', 'wrong-target', 'failed', 'interrupted'].map((response) => ({ command, response })),
))('stops before mutations for $response during $command', async ({ command, response }) => {
  const f = fixture();
  const original = f.deps.run;
  f.deps.run = async (args, cwd) => {
    const result = await original(args, cwd);
    if (args.includes('--help') || args.slice(0, 2).join(' ') !== command) return result;
    const target = { kind: 'linked', project_ref: ref };
    const stdout = response === 'invalid-json' ? 'SECRET invalid JSON'
      : response === 'null' ? 'null'
      : response === 'changed-schema' ? JSON.stringify({ target })
      : response === 'wrong-target' ? JSON.stringify({ ...JSON.parse(result.stdout), target: { ...target, project_ref: 'zzzzzzzzzzzzzzzzzzzz' } })
      : 'SECRET command diagnostic';
    return { stdout, stderr: 'SECRET credential', code: response === 'failed' ? 1 : response === 'interrupted' ? null : 0 };
  };
  await expect(deploy({ ...f.options, allowRemote: true }, f.deps)).rejects.toThrow(/^(?!.*SECRET)/);
  expect(f.mutations()).toHaveLength(0);
  expect(f.confirm).not.toHaveBeenCalled();
});

it.each(['subprocess', 'json', 'response', 'inspection', 'interrupted'])('retains %s diagnostics and reconciles only with fresh consent', async (stage) => {
  const f = fixture(); const original = f.deps.run;
  let deployed = false;
  f.deps.run = async (args, cwd) => {
    const result = await original(args, cwd);
    if (args.includes('--help')) return result;
    if (args[0] === 'functions' && args[1] === 'deploy') {
      deployed = true;
      if (stage === 'subprocess' || stage === 'interrupted') return { code: stage === 'interrupted' ? null : 1, stdout: '', stderr: 'connect ECONNREFUSED password=PRIVATE' };
      if (stage === 'json') return { ...result, stdout: 'PRIVATE' };
      if (stage === 'response') return { ...result, stdout: JSON.stringify({ target: {kind:'linked', project_ref:ref}, functions: [] }) };
    }
    if (stage === 'inspection' && deployed && args[0] === 'functions' && args[1] === 'list') return { code: 1, stdout: '', stderr: 'ECONNREFUSED PRIVATE' };
    return result;
  };
  const expectedStage = stage === 'inspection' ? 'post-deployment function inspection' : 'function deployment';
  await expect(deploy(f.options, f.deps)).rejects.toThrow(`Stage: ${expectedStage}`);
  // Read the existing journal via its public reader (filename is implementation-owned).
  const { readState } = await import('../../packages/cli/src/lib/deployment-state.ts');
  expect(readState(f.root, ref)?.phase).toBe('function_started');
  expect(f.logs.join('\n')).not.toContain('PRIVATE');
  f.deps.run = original;
  const before = f.mutations().length;
  await deploy({...f.options, dryRun:true}, f.deps);
  expect(f.mutations()).toHaveLength(before);
  expect(readState(f.root, ref)?.phase).toBe('function_started');
  await deploy(f.options, f.deps);
  expect(f.confirm).toHaveBeenCalledTimes(2);
  expect(readState(f.root, ref)?.phase).toBe('complete');
});

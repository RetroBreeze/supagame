import { readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
    expect(args).toContain(`--remote=${ref}`);
    const target = {
      kind: 'linked',
      project_ref: badTarget ? 'zzzzzzzzzzzzzzzzzzzz' : ref,
    };
    const names = readdirSync(join(cwd, 'supabase/migrations')).sort();
    const pending = names.filter((name) => !applied.has(name.slice(0, 14)));
    const json = (data: object) => ({
      code: 0,
      stdout: JSON.stringify({ ...data, target }),
      stderr: '',
    });
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
    calls.filter(({ args }) =>
      (args[0] === 'db' && !args.includes('--dry-run')) ||
      (args[0] === 'functions' && args[1] === 'deploy')
    );
  return {
    root,
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
  put(f.root, 'supabase/config.json', '{"db":{"seed":{"enabled":true}}}');
  put(f.root, 'supabase/functions/other/index.ts', 'throw new Error();');
  put(f.root, 'supabase/seed.sql', 'select 1;');
  const run = f.deps.run;
  f.deps.run = async (args, cwd) => {
    const files = Object.keys(snapshot(cwd));
    expect(files).not.toContain('.env');
    expect(files).not.toContain('supabase/config.json');
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

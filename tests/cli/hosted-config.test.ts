import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostedConfiguration, planOrigins } from '../../packages/cli/src/lib/hosted-config.ts';
import { digest } from '../../packages/cli/src/lib/deployment-files.ts';
import { ref } from './project-fixture.ts';
const origin = 'http://localhost:5173';
const value = JSON.stringify([origin]);
const hash = digest(value);
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
function fixture() {
  let anonymous = false;
  let secret: string | null = null;
  let fault:
    | 'permission'
    | 'target'
    | 'unrelated'
    | 'missing'
    | 'masked'
    | 'local-only'
    | 'no-effect'
    | undefined;
  const calls: readonly string[][] = [];
  const run = vi.fn(async (args: readonly string[], cwd: string) => {
    (calls as string[][]).push([...args]);
    const config = readFileSync(join(cwd, 'supabase/config.toml'), 'utf8');
    expect(config).toBe(
      'project_id = "supagame-hosted-configuration"\n[auth]\nenable_anonymous_sign_ins = true\n',
    );
    expect(args).toContain(`--remote=${ref}`);
    if (fault === 'permission') {
      return { code: 1, stdout: '', stderr: 'secret credential' };
    }
    let data: object = {};
    if (args[0] === 'config' && args[1] === 'diff') {
      data = {
        schema_version: 1,
        scope: {
          present: fault === 'missing' ? [] : ['auth', 'realtime'],
          missing: [],
        },
        changes: [
          ...(!anonymous
            ? [{
              path: ['auth', 'enable_anonymous_sign_ins'],
              class: fault === 'local-only' ? 'local_only' : 'update',
              declared: true,
              local: true,
              remote: false,
            }]
            : []),
          ...(fault === 'unrelated'
            ? [{
              path: ['auth', 'site_url'],
              class: 'update',
              declared: true,
              local: 'evil',
              remote: 'safe',
            }]
            : []),
          {
            path: ['auth', 'site_url'],
            class: 'remote_only',
            declared: false,
            local: 'default',
            remote: 'https://game.test',
          },
        ],
        masked: fault === 'masked' ? [['auth', 'enable_anonymous_sign_ins']] : [],
        unmanaged: [],
      };
    } else if (args[0] === 'config') {
      expect(args).toContain('--yes');
      if (fault !== 'no-effect') anonymous = true;
    } else if (args[1] === 'list') {
      data = {
        secrets: secret ? [{ name: 'SG_ALLOWED_ORIGINS', value: secret }] : [],
      };
    } else {
      expect(args).toContain('--yes');
      const file = args[args.indexOf('--env-file') + 1]!;
      expect(readFileSync(file, 'utf8')).toBe(
        `SG_ALLOWED_ORIGINS='${value}'\n`,
      );
      if (fault !== 'no-effect') secret = hash;
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        ...data,
        target: {
          kind: 'linked',
          project_ref: fault === 'target' ? 'z'.repeat(20) : ref,
          project_name: 'game',
        },
      }),
      stderr: '',
    };
  });
  const client = new HostedConfiguration(run, ref);
  cleanups.push(() => client.remove());
  return {
    client,
    calls,
    run,
    fault: (v: typeof fault) => {
      fault = v;
    },
    set: (a: boolean, s: string | null) => {
      anonymous = a;
      secret = s;
    },
  };
}
it('reads exact hosted settings without mutating and preserves unrelated remote-only configuration', async () => {
  const f = fixture();
  expect(await f.client.inspect()).toMatchObject({
    anonymous: false,
    originDigest: null,
    realtimeConfig: true,
  });
  expect(f.calls.every((c) => c[1] === 'diff' || c[1] === 'list')).toBe(true);
});
it.each(
  [
    'permission',
    'target',
    'unrelated',
    'missing',
    'masked',
    'local-only',
  ] as const,
)('fails closed for %s without leaking raw output', async (fault) => {
  const f = fixture();
  f.fault(fault);
  await expect(f.client.inspect()).rejects.toThrow();
  try {
    await f.client.inspect();
  } catch (e) {
    expect(String(e)).not.toContain('secret credential');
  }
});
it('writes only the selected auth property and origin secret, then verifies both', async () => {
  const f = fixture();
  await f.client.enableAnonymous();
  await f.client.setOrigins([origin], null);
  expect(await f.client.inspect()).toMatchObject({
    anonymous: true,
    originDigest: hash,
  });
});
it('never reports a successful write without read-back evidence', async () => {
  const f = fixture();
  f.fault('no-effect');
  await expect(f.client.enableAnonymous()).rejects.toThrow(/verif/i);
  await expect(f.client.setOrigins([origin], null)).rejects.toThrow(/verif/i);
});
it('creates, adopts identical digests and preserves unmanaged legacy secrets', () => {
  expect(planOrigins([origin], null, null, false).action).toBe('create');
  expect(planOrigins([origin], hash, null, false).action).toBe('unchanged');
  expect(planOrigins(undefined, hash, null, false).action).toBe('unmanaged');
});
it('requires explicit replacement for unknown secret values or remote drift', () => {
  expect(planOrigins([origin], 'a'.repeat(64), null, false).action).toBe(
    'blocked',
  );
  expect(planOrigins([origin], 'a'.repeat(64), null, true).action).toBe(
    'replace',
  );
  const receipt = { origins: [origin], digest: hash };
  expect(
    planOrigins([origin, 'https://game.test'], 'b'.repeat(64), receipt, false)
      .action,
  ).toBe('blocked');
});
it('only automatically updates verified managed origins with a superset', () => {
  const receipt = { origins: [origin], digest: hash };
  expect(
    planOrigins([origin, 'https://game.test'], hash, receipt, false).action,
  ).toBe('update');
  expect(planOrigins(['https://game.test'], hash, receipt, false).action).toBe(
    'blocked',
  );
  expect(
    planOrigins([origin, 'https://game.test'], hash, {
      ...receipt,
      origins: ['https://different.test'],
    }, false).action,
  ).toBe('blocked');
});

it('refuses remote-only evidence for the explicitly declared Auth prerequisite', async () => {
  const f = fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, cwd) => {
    const result = await original(args, cwd);
    if (args[0] === 'config' && args[1] === 'diff') {
      const data = JSON.parse(result.stdout);
      data.changes[0].class = 'remote_only';
      data.changes[0].declared = false;
      return { ...result, stdout: JSON.stringify(data) };
    }
    return result;
  });
  await expect(f.client.inspect()).rejects.toThrow();
});
it.each([
  { path: ['auth', 'enable_signup'], remote: false },
  { path: ['auth', 'captcha', 'enabled'], remote: true },
])(
  'detects anonymous-account prerequisites without changing unrelated Auth security settings',
  async (change) => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (args, cwd) => {
      const result = await original(args, cwd);
      if (args[0] === 'config' && args[1] === 'diff') {
        const data = JSON.parse(result.stdout);
        data.changes.push({
          ...change,
          class: 'remote_only',
          declared: false,
          local: !change.remote,
        });
        return { ...result, stdout: JSON.stringify(data) };
      }
      return result;
    });
    expect((await f.client.inspect()).authBlockers).toHaveLength(1);
  },
);
it('rechecks the origin digest immediately before writing and refuses intervening drift', async () => {
  const f = fixture();
  f.set(true, 'a'.repeat(64));
  await expect(f.client.setOrigins([origin], null)).rejects.toThrow(/changed/);
  expect(f.calls.some(c => c[0] === 'secrets' && c[1] === 'set')).toBe(false);
});

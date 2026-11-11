import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { cli, initialized, manifest, project, snapshot } from './project-fixture.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
it('stages optional admin repeatably and previews without writes', () => {
  const root = project();
  roots.push(root);
  initialized(root);
  const before = snapshot(root);
  expect(cli(root, 'add', 'admin', '--dry-run').status).toBe(0);
  expect(snapshot(root)).toEqual(before);
  expect(cli(root, 'add', 'admin').status).toBe(0);
  expect(manifest(root).modules.admin).toBe('0.1.4');
  const installed = snapshot(root);
  expect(cli(root, 'add', 'admin').status).toBe(0);
  expect(snapshot(root)).toEqual(installed);
  expect(cli(root, 'upgrade', '--dry-run').status).toBe(0);
});

import { adminCommand, type AdminDependencies } from '../../packages/cli/src/commands/admin.ts';
import { adminMutation } from '../../packages/cli/src/lib/admin.ts';
function setup() {
  const root = project();
  roots.push(root);
  initialized(root);
  expect(cli(root, 'add', 'admin').status).toBe(0);
  const calls: readonly string[][] = [];
  const mutable = calls as string[][];
  const deps: AdminDependencies = {
    run: async (args) => {
      mutable.push([...args]);
      return {
        code: 0,
        stdout: args[0] === '--version' ? '3.0.0' : JSON.stringify([{ result: { revision: 0 } }]),
        stderr: '',
      };
    },
    log: () => {},
    interactive: false,
    confirm: async () => '',
  };
  return { root, calls, deps };
}
it('dry run uses exclusively read-only queries and never prompts', async () => {
  const { root, calls, deps } = setup();
  deps.confirm = async () => {
    throw Error('unexpected prompt');
  };
  await adminCommand('leaderboard', 'reset', 'board', {
    workdir: root,
    local: true,
    dryRun: true,
  }, deps);
  expect(
    calls.filter((c) => c[0] === 'db').every((c) => c.includes('--read-only')),
  ).toBe(true);
});
it('noninteractive mutations require explicit consent', async () => {
  const { root, calls, deps } = setup();
  await expect(
    adminCommand('leaderboard', 'reset', 'board', {
      workdir: root,
      local: true,
      reason: 'test',
    }, deps),
  ).rejects.toThrow('confirmation');
  expect(calls.filter((c) => c[0] === 'db')).toHaveLength(1);
});
it('confirmed mutation includes reason, revision, operation and explicit CLI consent', async () => {
  const { root, calls, deps } = setup();
  await adminCommand('leaderboard', 'reset', 'board', {
    workdir: root,
    local: true,
    reason: 'test',
    yes: true,
  }, deps);
  expect(calls.at(-1)).toContain('--yes');
  expect(calls.at(-1)?.[2]).toContain('sg_private.admin_apply');
  expect(calls.at(-1)?.[2]).toContain("'test'");
});
it('missing reason never writes', async () => {
  const { root, calls, deps } = setup();
  await expect(
    adminCommand('leaderboard', 'reset', 'board', {
      workdir: root,
      local: true,
      yes: true,
    }, deps),
  ).rejects.toThrow('--reason');
  expect(
    calls.filter((c) => c[0] === 'db').every((c) => c.includes('--read-only')),
  ).toBe(true);
});
it('wrong project fails before invoking Supabase', async () => {
  const { root, calls, deps } = setup();
  await expect(
    adminCommand('leaderboard', 'list', undefined, {
      workdir: root,
      remote: true,
      projectRef: 'zzzzzzzzzzzzzzzzzzzz',
    }, deps),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it('network errors withhold raw secrets', async () => {
  const { root, deps } = setup();
  deps.run = async () => {
    throw Error('secret-value');
  };
  await expect(
    adminCommand(
      'audit',
      'list',
      undefined,
      { workdir: root, local: true },
      deps,
    ),
  ).rejects.toThrow('withheld');
});
it('validates operation inputs and quotes SQL literals', () => {
  expect(() =>
    adminMutation({
      action: 'score.hide',
      target: 'x',
      revision: -1,
      operationId: 'bad',
      reason: 'why',
    })
  ).toThrow();
  expect(
    adminMutation({
      action: 'score.hide',
      target: "x'",
      revision: 0,
      operationId: '90000000-0000-4000-8000-000000000001',
      reason: "player's appeal",
    }),
  ).toContain("'player''s appeal'");
});

it('invalid target never reaches a mutation', async () => {
  const { root, calls, deps } = setup();
  deps.run = async (args) => {
    (calls as string[][]).push([...args]);
    return { code: 0, stdout: args[0] === '--version' ? '3.0.0' : '[]', stderr: '' };
  };
  await expect(
    adminCommand('score', 'hide', '90000000-0000-4000-8000-000000000001', {
      workdir: root,
      local: true,
      yes: true,
      reason: 'test',
    }, deps),
  ).rejects.toThrow('Target not found');
  expect(calls.filter((c) => c[0] === 'db').every((c) => c.includes('--read-only'))).toBe(true);
});
it('declined interactive confirmation never writes', async () => {
  const { root, calls, deps } = setup();
  deps.interactive = true;
  deps.confirm = async () => 'no';
  await expect(
    adminCommand(
      'leaderboard',
      'reset',
      'board',
      { workdir: root, local: true, reason: 'test' },
      deps,
    ),
  ).rejects.toThrow('Declined');
  expect(calls.filter((c) => c[0] === 'db')).toHaveLength(1);
});
it('permission failures withhold diagnostics and provide safe retry coordinates', async () => {
  const { root, deps } = setup();
  const original = deps.run;
  deps.run = async (args, cwd) =>
    args[0] === 'db' && !args.includes('--read-only')
      ? { code: 1, stdout: 'secret-value', stderr: 'secret-value' }
      : original(args, cwd);
  await expect(
    adminCommand('leaderboard', 'reset', 'board', {
      workdir: root,
      local: true,
      yes: true,
      reason: 'test',
    }, deps),
  ).rejects.toThrow('outcome is unknown');
});
it('a supplied operation ID requires its original expected revision', async () => {
  const { root, calls, deps } = setup();
  await expect(
    adminCommand('leaderboard', 'reset', 'board', {
      workdir: root,
      local: true,
      yes: true,
      reason: 'test',
      operationId: '90000000-0000-4000-8000-000000000001',
    }, deps),
  ).rejects.toThrow('--expected-revision');
  expect(calls.filter((c) => c[0] === 'db')).toHaveLength(1);
});

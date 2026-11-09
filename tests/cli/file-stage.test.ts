import { hostname } from 'node:os';
import { chmodSync, linkSync, lstatSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, put, repo, snapshot } from './project-fixture.ts';
import { applyPlan, planFiles } from '../../packages/cli/src/lib/file-stage.ts';
const roots: string[] = [];
function fixture() {
  const root = project();
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
describe('safe file staging', () => {
  it('rolls back both creates and updates after a write failure', () => {
    const root = fixture();
    put(root, 'original.txt', 'before');
    const before = snapshot(root);
    const plan = planFiles(root, [{
      path: 'original.txt',
      content: Buffer.from('after'),
      replace: Buffer.from('before'),
    }, { path: 'new/deep/file.txt', content: Buffer.from('new') }]);
    expect(() =>
      applyPlan(root, plan, {
        afterWrite: (path) => {
          if (path === 'new/deep/file.txt') {
            throw new Error('simulated I/O failure');
          }
        },
      })
    ).toThrow(/simulated/);
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['original.txt', 'supabase']);
  });
  it('revalidates a preview before writes', () => {
    const root = fixture();
    const plan = planFiles(root, [{
      path: 'target.txt',
      content: Buffer.from('ours'),
    }]);
    put(root, 'target.txt', 'theirs');
    expect(() => applyPlan(root, plan)).toThrow(/changed|conflict/i);
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('theirs');
  });
  it.each([
    '../outside',
    '/tmp/outside',
    'nested/../../outside',
    'C:\\outside',
    'nested\\outside',
  ])('rejects unsafe path %s', (path) => {
    const root = fixture();
    expect(() => planFiles(root, [{ path, content: Buffer.from('bad') }]))
      .toThrow(/path/i);
  });
  it('checks symlink swaps between planning and execution', () => {
    const root = fixture();
    const outside = fixture();
    const plan = planFiles(root, [{
      path: 'nested/file',
      content: Buffer.from('ours'),
    }]);
    symlinkSync(outside, join(root, 'nested'));
    const before = snapshot(outside);
    expect(() => applyPlan(root, plan)).toThrow(/symlink/i);
    expect(snapshot(outside)).toEqual(before);
  });
  it('resumes after process interruption without duplicating or overwriting completed files', () => {
    const root = fixture();
    const script = `import {planFiles,applyPlan} from ${
      JSON.stringify(
        pathToFileURL(join(repo, 'packages/cli/src/lib/file-stage.ts')).href,
      )
    };
      const root=process.argv[1];applyPlan(root,planFiles(root,[{path:'one.txt',content:Buffer.from('one')},{path:'two.txt',content:Buffer.from('two')}]),{afterWrite:()=>process.exit(73)});`;
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      root,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(73);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('one');
    applyPlan(
      root,
      planFiles(root, [{ path: 'one.txt', content: Buffer.from('one') }, {
        path: 'two.txt',
        content: Buffer.from('two'),
      }]),
    );
    expect(readFileSync(join(root, 'two.txt'), 'utf8')).toBe('two');
    expect(readdirSync(root)).not.toContain('.supagame-stage');
  });
});

it('cleans an interrupted final commit on an unchanged rerun', () => {
  const root = fixture();
  const script = `import {planFiles,applyPlan} from ${
    JSON.stringify(
      pathToFileURL(join(repo, 'packages/cli/src/lib/file-stage.ts')).href,
    )
  };
    const root=process.argv[1];applyPlan(root,planFiles(root,[{path:'done.txt',content:Buffer.from('done')}]),{afterWrite:()=>process.exit(73)});`;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    script,
    root,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(73);
  applyPlan(
    root,
    planFiles(root, [{ path: 'done.txt', content: Buffer.from('done') }]),
  );
  expect(readdirSync(root)).not.toContain('.supagame-stage');
});

it('preserves existing file permissions during successful updates', () => {
  const root = fixture();
  put(root, 'mode.txt', 'before');
  chmodSync(join(root, 'mode.txt'), 0o666);
  applyPlan(
    root,
    planFiles(root, [{
      path: 'mode.txt',
      content: Buffer.from('after'),
      replace: Buffer.from('before'),
    }]),
  );
  expect(lstatSync(join(root, 'mode.txt')).mode & 0o777).toBe(0o666);
});
it('refuses an active installer lock without changing files', () => {
  const root = fixture();
  put(root, '.supagame-stage/owner.json', JSON.stringify({ pid: process.pid, host: hostname() }));
  const before = snapshot(root);
  expect(() => applyPlan(root, planFiles(root, [{ path: 'new.txt', content: Buffer.from('new') }])))
    .toThrow(/running/);
  expect(snapshot(root)).toEqual(before);
});
it('does not replace a concurrent user edit while rolling back', () => {
  const root = fixture();
  put(root, 'original.txt', 'before');
  expect(() =>
    applyPlan(
      root,
      planFiles(root, [{
        path: 'original.txt',
        content: Buffer.from('after'),
        replace: Buffer.from('before'),
      }]),
      {
        afterWrite: () => {
          put(root, 'original.txt', 'user changed it');
          throw new Error('failure');
        },
      },
    )
  ).toThrow(/concurrent changes were preserved/);
  expect(readFileSync(join(root, 'original.txt'), 'utf8')).toBe('user changed it');
});
it('rejects hard-linked destinations before reading', () => {
  const root = fixture();
  const outside = fixture();
  put(outside, 'linked.txt', 'private');
  linkSync(join(outside, 'linked.txt'), join(root, 'linked.txt'));
  expect(() => planFiles(root, [{ path: 'linked.txt', content: Buffer.from('bad') }])).toThrow(
    /hard-linked/,
  );
  expect(readFileSync(join(outside, 'linked.txt'), 'utf8')).toBe('private');
});

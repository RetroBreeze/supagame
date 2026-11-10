import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { cli, initialized, project, manifest, snapshot } from './project-fixture.ts';
it('stages optional live module and dependencies atomically, repeatedly, and in dry run', () => {
  const root = project();
  try {
    initialized(root);
    const before = snapshot(root);
    expect(cli(root, 'add', 'live-leaderboards', '--dry-run').status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(cli(root, 'add', 'live-leaderboards').status).toBe(0);
    expect(manifest(root).modules).toEqual({
      core: '0.1.2',
      leaderboards: '0.1.2',
      'live-leaderboards': '0.1.2',
    });
    const installed = snapshot(root);
    expect(cli(root, 'add', 'live-leaderboards').status).toBe(0);
    expect(cli(root, 'upgrade').status).toBe(0);
    expect(snapshot(root)).toEqual(installed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

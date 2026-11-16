import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('npm-packed contracts include the canonical license and a publishable manifest', () => {
  const destination = mkdtempSync(join(tmpdir(), 'supagame-npm-artifact-'));
  try {
    execFileSync('npm', ['pack', '--pack-destination', destination], {
      cwd: join(root, 'packages/contracts'), stdio: 'pipe', timeout: 60_000,
    });
    const archive = join(destination, 'retrobreeze-supagame-contracts-0.1.0.tgz');
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n');
    assert.ok(files.includes('package/LICENSE'), 'npm must ship LICENSE');
    assert.equal(execFileSync('tar', ['-xOzf', archive, 'package/LICENSE'], { encoding: 'utf8' }),
      readFileSync(join(root, 'LICENSE'), 'utf8'));
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
    assert.notEqual(manifest.private, true, 'Distribution packages must permit publication');
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

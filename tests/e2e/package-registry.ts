import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Read-only registry for the three actual tarballs. External dependencies continue
// to use npm; nothing here can publish, proxy credentials or accept writes.
export async function installFromRegistry(root: string, tarballs: string[]): Promise<void> {
  const packages = tarballs.map((archive) => ({
    manifest: JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' })),
    readme: execFileSync('tar', ['-xOzf', archive, 'package/README.md'], { encoding: 'utf8' }),
    bytes: readFileSync(archive),
  }));
  const sdk = packages.find(({ manifest }) => manifest.name === '@retrobreeze/supagame-sdk');
  assert.ok(sdk);
  // Follow the shipped installation instructions. Supplying undeclared type
  // prerequisites here would hide a broken clean TypeScript installation.
  const documentedDependencies = [...sdk.readme.matchAll(/^npm install (.+)$/gm)]
    .flatMap((match) => match[1]!.split(/\s+/).filter((argument) => !argument.startsWith('-')));
  assert.ok(documentedDependencies.includes('@retrobreeze/supagame-sdk'));
  const fetched = new Set<string>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const path = decodeURIComponent(request.url ?? '').slice(1);
    const entry = packages.find(({ manifest }) => path === manifest.name || path === `${manifest.name}/archive.tgz`);
    if (!entry) { response.writeHead(404).end(); return; }
    const { manifest, bytes } = entry;
    if (path.endsWith('/archive.tgz')) {
      fetched.add(manifest.name);
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name: manifest.name, 'dist-tags': { latest: manifest.version },
      versions: { [manifest.version]: { ...manifest, dist: {
        tarball: `${origin}/${manifest.name}/archive.tgz`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      } } },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(root, '.npmrc'), `registry=https://registry.npmjs.org/\n@retrobreeze:registry=${origin}/\n`);
  writeFileSync(join(root, 'empty-npmrc'), '');
  try {
    await promisify(execFile)('npm', ['install', '--engine-strict', '--no-audit', '--no-fund',
      '--cache', join(root, 'npm-cache'), '--userconfig', join(root, 'empty-npmrc'),
      '@retrobreeze/supagame-cli@0.1.0', ...documentedDependencies, 'typescript@5.9.3'], {
      cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      // Do not inherit registry overrides, auth tokens or NODE_PATH from the host.
      env: { PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot },
    });
    assert.deepEqual([...fetched].sort(), [
      '@retrobreeze/supagame-cli', '@retrobreeze/supagame-contracts', '@retrobreeze/supagame-sdk',
    ]);
    const consumer = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(consumer.dependencies['@retrobreeze/supagame-contracts'], undefined,
      'Contracts must resolve transitively, not as a supplied top-level dependency');
  } catch {
    throw new Error('Isolated npm registry installation failed; subprocess output withheld.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

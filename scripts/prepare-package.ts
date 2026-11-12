import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = process.argv[2];
if (name !== 'cli' && name !== 'sdk-ts' && name !== 'contracts') {
  throw new Error('Select a package: cli, sdk-ts or contracts.');
}

function compile(packageName: string) {
  const directory = join(root, 'packages', packageName);
  // Only this package's generated output is removed. Source and consumer files
  // never participate; a failed build must not silently reuse an older release.
  rmSync(join(directory, 'dist'), { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit',
  });
}

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
}

// SDK declarations depend on the workspace contracts package. Packing the SDK
// directly in a clean checkout must not depend on an earlier contracts build.
if (name === 'sdk-ts') compile('contracts');
compile(name);
if (name === 'cli') {
  execFileSync(process.execPath, [join(root, 'packages/cli/scripts/copy-assets.ts')], { cwd: root, stdio: 'inherit' });
}

const directory = join(root, 'packages', name);
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const required = [...targets(manifest.bin), ...targets(manifest.exports)];
if (name === 'cli') {
  const { templateSources } = await import('../packages/cli/src/lib/templates.ts');
  required.push(...templateSources.map((path) => `dist/assets/${path}`));
  required.push(...['index.html', 'app.js', 'style.css'].map((path) => `dist/dashboard/${path}`));
}
for (const path of required) {
  let valid = false;
  try { const stat = lstatSync(join(directory, path)); valid = stat.isFile() && stat.size > 0; }
  catch { /* Report the required public artifact, rather than an internal fs error. */ }
  if (!valid) throw new Error(`Cannot pack ${manifest.name}: missing or empty artifact ${path}.`);
}
console.log(`Built and verified ${manifest.name} for packing.`);

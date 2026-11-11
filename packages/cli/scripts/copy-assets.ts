import { copyFileSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { templateSources } from '../src/lib/templates.ts';

// Only immutable, explicitly inventoried assets belong in the CLI package.
// Never recursively copy module directories: they may contain local .env files.
const source = new URL('../../../', import.meta.url);
const target = new URL('../dist/assets/', import.meta.url);
rmSync(target, { recursive: true, force: true });
for (const path of templateSources) {
  const original = new URL(path, source);
  if (!lstatSync(original).isFile()) throw new Error(`Expected regular template source: ${path}`);
  const destination = new URL(path, target);
  mkdirSync(new URL('./', destination), { recursive: true });
  copyFileSync(original, destination);
}

// The loopback UI is shipped with the CLI, never fetched from a CDN.
const dashboardSource = new URL('../dashboard/', import.meta.url);
const dashboardTarget = new URL('../dist/dashboard/', import.meta.url);
mkdirSync(dashboardTarget, { recursive: true });
for (const file of ['index.html', 'style.css']) copyFileSync(new URL(file,dashboardSource),new URL(file,dashboardTarget));
const { build } = await import('esbuild');
const { fileURLToPath } = await import('node:url');
await build({entryPoints:[fileURLToPath(new URL('app.ts',dashboardSource))],outfile:fileURLToPath(new URL('app.js',dashboardTarget)),bundle:true,platform:'browser',target:'es2022',format:'esm',minify:true});

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

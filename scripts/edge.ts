import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Edge dependencies are pinned npm: imports in deno.lock. Do not add the
// Node development workspace (or its optional native tools) to that graph.
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('deno/bin.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DENO_NO_PACKAGE_JSON: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

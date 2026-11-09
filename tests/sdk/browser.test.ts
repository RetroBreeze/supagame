import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { fixture, profile } from './fixtures.js';
import type { createGameServices } from '../../packages/sdk-ts/src/index.js';

it('bundles and runs in a browser environment without Node globals, runtime dependencies or eval', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../../packages/sdk-ts/src/index.ts', import.meta.url))], bundle: true, platform: 'browser', format: 'iife', globalName: 'Supagame', write: false, metafile: true, target: 'es2022' });
  for (const output of Object.values(result.metafile!.outputs)) expect(output.imports).toEqual([]);
  const browser: { Supagame?: { createGameServices: typeof createGameServices } } = {};
  // The sandbox deliberately has no process, Buffer, require, localStorage or dynamic code generation.
  runInNewContext(result.outputFiles[0]!.text, browser, { contextCodeGeneration: { strings: false, wasm: false } });
  const f = fixture();
  expect(await browser.Supagame!.createGameServices({ supabase: f.supabase }).players.getMe()).toEqual(profile);
});

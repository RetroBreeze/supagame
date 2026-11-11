import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export function run(command: string, args: string[], cwd = repo, env = process.env): string {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Subprocess output may contain local Supabase keys. Never attach raw output/cause.
    throw new Error(`${command.split('/').at(-1)} ${args[0] ?? ''} failed in the isolated test fixture; output withheld.`);
  }
}
export function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}
export async function packedConsumer() {
  const root = mkdtempSync(join(tmpdir(), 'supagame-packages-'));
  try {
    const tarballs = ['contracts', 'sdk-ts', 'cli'].map((name) => {
      run('pnpm', ['pack', '--pack-destination', root], join(repo, 'packages', name));
      const archive = join(root, `supagame-${name}-${name === 'cli' ? '0.1.6' : '0.1.4'}.tgz`);
      const entries = run('tar', ['-tzf', archive]).trim().split('\n');
      assert.ok(entries.includes('package/package.json'));
      assert.ok(entries.includes('package/LICENSE'), `${name} must distribute its MIT license`);
      assert.ok(!entries.some((entry) => /(?:^|\/)(?:node_modules|tests|scripts|\.git|\.superpowers)\//.test(entry)));
      assert.ok(!entries.some((entry) => /\/(?:\.env(?:\.(?!example$).*)?|supagame\.config\.json|\.supagame-deploy.*)$/.test(entry)));
      assert.ok(!entries.some((entry) => entry.startsWith('package/src/')));
      return archive;
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, '@supabase/supabase-js@2.119.0', 'typescript@5.9.3', '@types/node@24.19.2'], root);
    const installed = (name: string) => join(root, 'node_modules', '@supagame', name);
    const cli = join(root, 'node_modules', '.bin', 'supagame');
    assert.match(run(cli, ['--help'], root), /leaderboard/);
    for (const name of ['cli', 'sdk-ts', 'contracts']) {
      const manifest = JSON.parse(readFileSync(join(installed(name), 'package.json'), 'utf8'));
      assert.equal(manifest.license, 'MIT'); assert.equal(manifest.version, name === 'cli' ? '0.1.6' : '0.1.4');
      assert.equal(manifest.private, true, 'Publishing remains separately authorized');
      assert.ok(!JSON.stringify(manifest.dependencies ?? {}).includes('workspace:'));
    }
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/modules/leaderboards/functions/supagame/index.ts'), 'utf8').includes('Deno.serve'));
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/packages/contracts/src/generated.ts'), 'utf8').includes('export interface components'));
    assert.ok(readFileSync(join(installed('contracts'), 'dist/generated.d.ts'), 'utf8').includes('export interface components'));
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/modules/cloud-saves/migrations/007_save_revisions.sql'), 'utf8').includes('create table sg_private.save_revisions'));
    assert.ok(readFileSync(join(installed('contracts'), 'openapi.yaml'), 'utf8').includes('openapi: 3.1.0'));
    writeFileSync(join(root, 'consumer.ts'), `import { createClient } from '@supabase/supabase-js';
import { createGameServices, ApiError, type PlayerProfile, type LeaderboardPage } from '@supagame/sdk-ts';
const game = createGameServices({ supabase: createClient('https://example.supabase.co', 'sb_publishable_placeholder') });
const saves = game.saves;
void game.players.getAuthStatus; void game.players.linkProvider; void game.players.handleAuthCallback;
void saves.prepareAccountSwitch; void saves.resolveAccountSwitch;
void game.players.cancelAuthFlow;
const backups = saves.listRevisions('profile');
const restored = saves.restoreRevision('profile', 1, {expectedRevision: 2});
void [backups, restored, saves.loadRevision, saves.loadBinaryRevision];
const save = saves.save('profile', {coins: 5}, {expectedRevision: 0});
void save;
const profile: Promise<PlayerProfile> = game.players.getMe();
const page: Promise<LeaderboardPage> = game.leaderboards.getTop('level-1', { limit: 10 });
const subscription = game.leaderboards.subscribe('level-1', {onUpdate(page) { void page.entries; }, onRankChange(event) { void event.previousRank; }});
subscription.unsubscribe();
void [profile, page, ApiError];\n`);
    run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.ts'], root);
    const bundle = await build({ entryPoints: [join(root, 'consumer.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    assert.ok(Object.values(bundle.metafile!.outputs).every((output) => output.imports.length === 0));
    // Supabase's realtime package has an optional Node ws adapter; the browser build must exclude it.
    assert.ok(!Object.keys(bundle.metafile!.inputs).some((path) => /node_modules\/ws\//.test(path)));
    writeFileSync(join(root, 'runtime.mjs'), `export * as sdk from '@supagame/sdk-ts'; export { createClient } from '@supabase/supabase-js';`);
    const runtime = await import(pathToFileURL(join(root, 'runtime.mjs')).href) as {
      sdk: typeof import('../../packages/sdk-ts/src/index.js');
      createClient: typeof import('@supabase/supabase-js').createClient;
    };
    assert.equal(typeof runtime.sdk.createGameServices, 'function');
    for (const name of ['ApiError', 'AuthenticationError', 'NetworkError', 'InvalidParameterError', 'UnexpectedResponseError'] as const) assert.equal(typeof runtime.sdk[name], 'function');
    return { root, cli, ...runtime, remove: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

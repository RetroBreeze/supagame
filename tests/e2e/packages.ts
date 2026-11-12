import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { installFromRegistry } from './package-registry.ts';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export function run(command: string, args: string[], cwd = repo, env = process.env): string {
  try {
    // Explicit POSIX shell fallback for pnpm's shebang-less bootstrap shim.
    // The command text is fixed; every argument is passed literally via argv.
    const executable = command === 'pnpm' ? 'sh' : command;
    const argv = command === 'pnpm' ? ['-c', 'exec pnpm "$@"', 'pnpm', ...args] : args;
    return execFileSync(executable, argv, { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Subprocess output may contain local Supabase keys. Never attach raw output/cause.
    throw new Error(`${command.split('/').at(-1)} ${args[0] ?? ''} failed in the isolated test fixture; output withheld.`);
  }
}
export function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}
export async function packedConsumer(source = repo) {
  const root = mkdtempSync(join(tmpdir(), 'supagame-packages-'));
  try {
    const tarballs = ['sdk-ts', 'contracts', 'cli'].map((name) => {
      run('pnpm', ['pack', '--pack-destination', root], join(source, 'packages', name));
      const archive = join(root, `retrobreeze-supagame-${name === 'sdk-ts' ? 'sdk' : name}-0.1.0.tgz`);
      const entries = run('tar', ['-tzf', archive]).trim().split('\n');
      assert.ok(entries.includes('package/package.json'));
      assert.ok(entries.includes('package/README.md'), `${name} must distribute usage documentation`);
      assert.ok(entries.includes('package/LICENSE'), `${name} must distribute its MIT license`);
      assert.ok(entries.includes(`package/dist/${name === 'cli' ? 'cli' : name === 'contracts' ? 'types' : 'index'}.js`), `${name} must build its runtime before packing`);
      assert.ok(!entries.includes('package/dist/stale-review-artifact.js'), 'Packaging must discard stale build output');
      assert.ok(!entries.some((entry) => /(?:^|\/)(?:node_modules|tests|scripts|\.git|\.superpowers)\//.test(entry)));
      assert.ok(!entries.some((entry) => /\/(?:\.env(?:\.(?!example$).*)?|supagame\.config\.json|\.supagame-deploy.*)$/.test(entry)));
      assert.ok(!entries.some((entry) => entry.startsWith('package/src/')));
      const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json']));
      assert.equal(manifest.name, `@retrobreeze/supagame-${name === 'sdk-ts' ? 'sdk' : name}`);
      assert.equal(manifest.version, '0.1.0');
      assert.equal(manifest.engines?.node, '^24.0.0 || ^26.0.0');
      assert.equal(manifest.publishConfig?.access, 'public');
      assert.equal(manifest.repository?.directory, `packages/${name}`);
      assert.equal(manifest.repository?.url, 'git+https://github.com/RetroBreeze/supagame.git');
      assert.equal(manifest.bugs?.url, 'https://github.com/RetroBreeze/supagame/issues');
      const targets = (value: unknown): string[] => typeof value === 'string' ? [value]
        : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
      for (const target of [...targets(manifest.exports), ...targets(manifest.bin)]) {
        assert.ok(entries.includes(`package/${target.replace(/^\.\//, '')}`), `Missing declared entry ${target}`);
      }
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        assert.ok(!/^(?:workspace:|file:|link:)/.test(String(version)), 'No source-checkout dependencies');
        assert.ok(!dependency.startsWith('@supagame/'));
        if (dependency.startsWith('@retrobreeze/')) assert.equal(version, '0.1.0');
      }
      if (name === 'sdk-ts') assert.deepEqual(manifest.dependencies, { '@retrobreeze/supagame-contracts': '0.1.0' });
      return archive;
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await installFromRegistry(root, tarballs);
    const installed = (name: string) => join(root, 'node_modules', '@retrobreeze', `supagame-${name === 'sdk-ts' ? 'sdk' : name}`);
    const cli = join(root, 'node_modules', '.bin', 'supagame');
    assert.match(run(cli, ['--help'], root), /leaderboard/);
    for (const name of ['cli', 'sdk-ts', 'contracts']) {
      assert.ok(realpathSync(installed(name)).startsWith(`${root}/node_modules/`));
      const manifest = JSON.parse(readFileSync(join(installed(name), 'package.json'), 'utf8'));
      assert.equal(manifest.license, 'MIT'); assert.equal(manifest.version, '0.1.0');
      assert.equal(manifest.private, true, 'Publishing remains separately authorized');
      assert.ok(!JSON.stringify(manifest.dependencies ?? {}).includes('workspace:'));
    }
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/modules/leaderboards/functions/supagame/index.ts'), 'utf8').includes('Deno.serve'));
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/packages/contracts/src/generated.ts'), 'utf8').includes('export interface components'));
    assert.ok(readFileSync(join(installed('contracts'), 'dist/generated.d.ts'), 'utf8').includes('export interface components'));
    assert.ok(readFileSync(join(installed('cli'), 'dist/assets/modules/cloud-saves/migrations/007_save_revisions.sql'), 'utf8').includes('create table sg_private.save_revisions'));
    assert.ok(readFileSync(join(installed('contracts'), 'openapi.yaml'), 'utf8').includes('openapi: 3.1.0'));
    writeFileSync(join(root, 'consumer.ts'), `import { createClient } from '@supabase/supabase-js';
import { createGameServices, ApiError, type PlayerProfile, type LeaderboardPage } from '@retrobreeze/supagame-sdk';
import { createIndexedDbStore, mountAchievementNotifications, watchSaveConnectivity } from '@retrobreeze/supagame-sdk/browser';
void [createIndexedDbStore, mountAchievementNotifications, watchSaveConnectivity];
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
    writeFileSync(join(root, 'runtime.mjs'), `export * as sdk from '@retrobreeze/supagame-sdk'; export * as browser from '@retrobreeze/supagame-sdk/browser'; export * as contracts from '@retrobreeze/supagame-contracts'; export { createClient } from '@supabase/supabase-js';`);
    const runtime = await import(pathToFileURL(join(root, 'runtime.mjs')).href) as {
      browser: typeof import('../../packages/sdk-ts/src/browser.js');
      contracts: object;
      sdk: typeof import('../../packages/sdk-ts/src/index.js');
      createClient: typeof import('@supabase/supabase-js').createClient;
    };
    assert.equal(typeof runtime.sdk.createGameServices, 'function');
    assert.equal(typeof runtime.browser.createIndexedDbStore, 'function');
    assert.equal(typeof runtime.contracts, 'object');
    for (const name of ['ApiError', 'AuthenticationError', 'NetworkError', 'InvalidParameterError', 'UnexpectedResponseError'] as const) assert.equal(typeof runtime.sdk[name], 'function');
    return { root, cli, ...runtime, remove: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

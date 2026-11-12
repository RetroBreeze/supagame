import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packedConsumer, repo, run } from './packages.ts';
import { packagedHostedOperator } from './admin-operator-transport.ts';
test('fresh source checkout builds CLI, contracts and SDK tarballs for an isolated consumer', { timeout: 300_000 }, async () => {
  const source = mkdtempSync(join(tmpdir(), 'supagame-source-'));
  let consumer: Awaited<ReturnType<typeof packedConsumer>> | undefined;
  try {
    run('git', ['clone', '--local', '--no-hardlinks', '--quiet', repo, source]);
    // Overlay tracked and untracked implementation files so this regression also
    // tests uncommitted fixes. Never copy ignored dist, node_modules or secrets.
    const paths = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--',
      'packages', 'modules', 'scripts', 'examples', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'tsconfig.base.json', 'deno.lock'], repo).trim().split('\n');
    for (const path of paths) {
      const destination = join(source, path);
      if (!existsSync(join(repo, path))) { rmSync(destination, { force: true }); continue; }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repo, path), destination);
    }
    for (const name of ['cli', 'contracts', 'sdk-ts']) assert.equal(existsSync(join(source, 'packages', name, 'dist')), false);
    run('pnpm', ['install', '--frozen-lockfile'], source);
    consumer = await packedConsumer(source);
    run(consumer.cli,['init','--project-ref','abcdefghijklmnopqrst'],consumer.root);
    run(consumer.cli,['add','admin','--dry-run'],consumer.root);
    run(consumer.cli,['add','admin'],consumer.root);
    run(consumer.cli,['admin','dashboard','--help'],consumer.root);
    for(const file of ['index.html','app.js','style.css']) assert.ok(existsSync(join(consumer.root,'node_modules/@retrobreeze/supagame-cli/dist/dashboard',file)));
    run(consumer.cli,['upgrade','--dry-run'],consumer.root);
    await packagedHostedOperator(consumer.cli, consumer.root);
    // A subsequent pack must not retain files from removed/renamed source modules.
    for (const name of ['cli', 'contracts', 'sdk-ts']) writeFileSync(join(source, 'packages', name, 'dist/stale-review-artifact.js'), 'throw Error("stale output");');
    const repacked = await packedConsumer(source);
    repacked.remove();
    // Compilation can exit successfully without emitting (e.g. a mistaken
    // noEmit setting). Artifact validation must still prevent a broken tarball.
    const configPath = join(source, 'packages/contracts/tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.compilerOptions.noEmit = true;
    writeFileSync(configPath, JSON.stringify(config));
    const rejected = join(source, 'rejected-pack');
    mkdirSync(rejected);
    const failed = spawnSync('sh', ['-c', 'exec pnpm "$@"', 'pnpm', 'pack', '--pack-destination', rejected], {
      cwd: join(source, 'packages/contracts'), encoding: 'utf8', timeout: 60_000,
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout + failed.stderr, /Cannot pack @retrobreeze\/supagame-contracts: missing or empty artifact/);
    assert.deepEqual(readdirSync(rejected), []);
  } finally { consumer?.remove(); rmSync(source, { recursive: true, force: true }); }
});

// pnpm's official installer can leave a valid shell shim without a shebang.
// Node 26 no longer performs Node 24's implicit shell fallback for execFileSync.
test('package runner supports pnpm shell shims and preserves literal arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'supagame-pnpm-shim-'));
  try {
    const shim = join(root, 'pnpm');
    writeFileSync(shim, '# pnpm bootstrap shim\nprintf \'%s\' "$1"\n');
    chmodSync(shim, 0o755);
    const literal = 'space and $(not-a-command); literal';
    assert.equal(run('pnpm', [literal], root, { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` }), literal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

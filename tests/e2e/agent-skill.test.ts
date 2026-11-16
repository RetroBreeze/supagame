import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { parse } from 'yaml';
import { packedConsumer, repo, run } from './packages.ts';

const skill = join(repo, '.agents/skills/supagame');
const markdown = () => [join(skill, 'SKILL.md'), ...readdirSync(join(skill, 'references')).map(name => join(skill, 'references', name))];

test('the portable skill has valid discovery metadata and self-contained relative references', () => {
  const main = readFileSync(join(skill, 'SKILL.md'), 'utf8');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(main);
  assert.ok(header);
  const metadata = parse(header[1]!);
  assert.equal(metadata.name, 'supagame');
  assert.ok(typeof metadata.description === 'string' && metadata.description.length > 0 && metadata.description.length <= 1024);
  for (const file of markdown()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https:\/\//.test(match[1]!)) continue;
      const target = resolve(dirname(file), match[1]!);
      assert.ok(target.startsWith(`${skill}/`), 'Bundled references must survive copying just the skill directory');
      assert.ok(existsSync(target), `Missing reference in ${file}: ${match[1]}`);
    }
  }
});

test('Godot example sends the documented authenticated JSON request', { timeout: 30_000 }, async t => {
  const available = spawnSync('godot', ['--version'], { encoding: 'utf8' });
  if (available.status !== 0 || !available.stdout.startsWith('4.')) return t.skip('Godot 4 is not installed');
  const guide = readFileSync(join(skill, 'references/http.md'), 'utf8');
  const snippet = /```gdscript\n([\s\S]*?)```/.exec(guide);
  assert.ok(snippet);
  const root = mkdtempSync(join(tmpdir(), 'supagame-skill-godot-'));
  let received: { path: string; method: string; key: string; auth: string; type: string; body: unknown } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = { path: request.url!, method: request.method!, key: String(request.headers.apikey), auth: String(request.headers.authorization), type: String(request.headers['content-type']), body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ outcome: 'best', score: 1250, bestScore: 1250 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(root, 'transport.gd'), snippet[1]!);
    writeFileSync(join(root, 'check.gd'), `extends SceneTree
func _initialize():
    var adapter = load("res://transport.gd").new()
    var http = HTTPRequest.new()
    root.add_child(adapter)
    adapter.add_child(http)
    await process_frame
    var reply = await adapter.submit_score(http, "http://127.0.0.1:${address.port}/functions/v1/supagame/v1", "sb_publishable_placeholder", "synthetic-session", 1250, "11111111-1111-4111-8111-111111111111")
    if reply.get("status") != 200 or reply.get("body", {}).get("bestScore") != 1250:
        quit(1)
        return
    quit(0)
`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('godot', ['--headless', '--path', root, '--script', 'check.gd'], { stdio: 'pipe' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Godot request timed out')); }, 20_000);
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Godot transport failed: ${output}`)); });
    });
    assert.deepEqual(received, {
      path: '/functions/v1/supagame/v1/leaderboards/arcade/scores', method: 'POST',
      key: 'sb_publishable_placeholder', auth: 'Bearer synthetic-session', type: 'application/json',
      body: { score: 1250, submissionKey: '11111111-1111-4111-8111-111111111111' },
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test('documented local CLI commands and TypeScript examples work in a packaged consumer', { timeout: 300_000 }, async () => {
  // Read first: a missing skill fails before expensive packaging.
  const guides = markdown().map(file => readFileSync(file, 'utf8'));
  const consumer = await packedConsumer();
  try {
    const copied = join(consumer.root, '.agents/skills/supagame');
    cpSync(skill, copied, { recursive: true });
    assert.ok(existsSync(join(copied, 'references/http.md')));
    const commands = guides.flatMap(guide => [...guide.matchAll(/<!-- local-check -->\s*```sh\n([\s\S]*?)```/g)])
      .flatMap(match => match[1]!.trim().split('\n'));
    assert.ok(commands.length > 0, 'Exercise the actual documented setup blocks');
    for (const mode of ['fresh', 'existing', 'native']) {
      const root = join(consumer.root, mode);
      mkdirSync(root);
      const original = '# Existing project: preserve Auth and unrelated function settings\nproject_id = "consumer"\n[auth]\nsite_url = "https://game.example"\nenable_anonymous_sign_ins = false\n[functions.existing]\nverify_jwt = true\n';
      if (mode === 'existing') {
        mkdirSync(join(root, 'supabase'));
        writeFileSync(join(root, 'supabase/config.toml'), original);
      }
      if (mode === 'native') writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
      for (const line of commands) {
        assert.ok(line.startsWith('npx supagame '));
        const args = line.slice('npx supagame '.length).match(/"[^"]*"|'[^']*'|[^\s]+/g)!
          .map(arg => arg.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2').replaceAll('YOUR_PROJECT_REF', 'abcdefghijklmnopqrst'));
        assert.ok(['init', 'add', 'leaderboard', 'achievement', 'saves', 'config', 'upgrade'].includes(args[0]!));
        assert.ok(!args.some(arg => ['--remote', '--allow-remote', 'cleanup'].includes(arg)), 'Documentation checks must remain local');
        if (mode === 'native') {
          if (args[0] === 'config') continue;
          const origin = args.indexOf('--origin');
          if (origin !== -1) args.splice(origin, 2); // Native builds omit browser-only configuration.
        }
        run(consumer.cli, [...args, '--no-interactive'], root);
      }
      const manifest = JSON.parse(readFileSync(join(root, 'supagame.config.json'), 'utf8'));
      assert.equal(manifest.projectRef, 'abcdefghijklmnopqrst');
      assert.equal(manifest.leaderboards[0].sortDirection, 'desc');
      assert.equal(manifest.achievements[0].condition.leaderboardId, 'arcade');
      assert.ok(manifest.modules['cloud-saves'] && manifest.modules['live-leaderboards']);
      if (mode === 'native') assert.equal(manifest.origins, undefined);
      else assert.ok(manifest.origins.includes('http://127.0.0.1:5173'));
      if (mode === 'existing') assert.ok(readFileSync(join(root, 'supabase/config.toml'), 'utf8').startsWith(original));
      if (mode === 'native') assert.equal(existsSync(join(root, 'package.json')), false);
      const diagnostic = JSON.parse(run(consumer.cli, ['doctor', '--json'], root));
      assert.equal(diagnostic.ok, true);
      assert.ok(diagnostic.result.findings.some((finding: { status: string; scope: string }) => finding.status === 'cannot verify' && finding.scope === 'database'));
      const before = readFileSync(join(root, 'supagame.config.json'));
      run(consumer.cli, ['init', '--project-ref', 'abcdefghijklmnopqrst', '--module', 'leaderboards', '--no-interactive'], root);
      assert.deepEqual(readFileSync(join(root, 'supagame.config.json')), before);
      const denied = spawnSync(consumer.cli, ['deploy', '--project-ref', 'abcdefghijklmnopqrst', '--no-interactive'], { cwd: root, encoding: 'utf8' });
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /Noninteractive deployment requires --allow-remote/);
      const mismatch = spawnSync(consumer.cli, ['init', '--project-ref', 'zzzzzzzzzzzzzzzzzzzz', '--no-interactive'], { cwd: root, encoding: 'utf8' });
      assert.equal(mismatch.status, 1);
      assert.deepEqual(readFileSync(join(root, 'supagame.config.json')), before);
    }
    const snippets = markdown().flatMap(file => [...readFileSync(file, 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]!));
    assert.ok(snippets.length > 0);
    const paths = snippets.map((code, i) => {
      const path = `skill-example-${i}.ts`;
      writeFileSync(join(consumer.root, path), code);
      return path;
    });
    run(join(consumer.root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2022,DOM', ...paths], consumer.root);
  } finally { consumer.remove(); }
});

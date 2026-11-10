import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { files, packedConsumer, repo, run } from './packages.ts';
import { localProject } from './local-project.ts';

test('fresh packaged installation: CLI → local Supabase → SDK/raw HTTP → browser', { timeout: 600_000 }, async (t) => {
  assert.ok(existsSync(join(repo, 'examples/browser-demo/src/main.ts')), 'The runnable consumer example must exist');
  const consumer = await packedConsumer();
  t.after(() => consumer.remove());
  const project = await localProject();
  t.after(() => project.remove());
  const interrupt = () => { try { project.remove(); consumer.remove(); } finally { process.exitCode = 130; } };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  t.after(() => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); });
  const cli = (...args: string[]) => run(consumer.cli, [...args, '--workdir', project.root], consumer.root);
  const snapshot = () => Object.fromEntries(files(project.root).map((path) => [path.slice(project.root.length), readFileSync(path, 'utf8')]));
  await t.test('installs twice without changing files and creates both board directions', () => {
    cli('init', '--project-ref', 'abcdefghijklmnopqrst', '--origin', `http://127.0.0.1:${project.browserPort}`);
    assert.match(readFileSync(join(project.root, 'supabase/functions/.env'), 'utf8'), /SG_ALLOWED_ORIGINS/);
    cli('add', 'leaderboards');
    cli('add', 'cloud-saves');
    const before = snapshot(); cli('init'); cli('add', 'leaderboards'); cli('add', 'cloud-saves'); assert.deepEqual(snapshot(), before);
    cli('leaderboard', 'create', 'level-1', '--type', 'time', '--order', 'asc', '--keep-best', '--min', '0', '--max', '1000000');
    cli('leaderboard', 'create', 'arcade', '--type', 'points', '--order', 'desc', '--keep-best', '--min', '0', '--max', '1000000');
    const boards = snapshot();
    cli('leaderboard', 'create', 'arcade', '--type', 'points', '--order', 'desc', '--keep-best', '--min', '0', '--max', '1000000');
    assert.deepEqual(snapshot(), boards);
    assert.ok(!readFileSync(join(project.root, 'supabase/functions/supagame/types.ts'), 'utf8').includes('../../../../'));
  });
  project.start();
  // Realtime service initialization owns its schema; stage the optional migration afterwards.
  cli('add', 'live-leaderboards');
  project.supabase(['migration', 'up', '--include-all']);
  const liveFiles = snapshot(); cli('add', 'live-leaderboards'); assert.deepEqual(snapshot(), liveFiles);
  // Never print the status object: it also contains privileged local fixture keys.
  const status = JSON.parse(project.supabase(['status', '--output', 'json'])) as Record<string, string>;
  assert.equal(status.API_URL, project.url);
  const key = status.PUBLISHABLE_KEY!; assert.ok(key.startsWith('sb_publishable_'));
  const makeClient = () => consumer.createClient(project.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const supabase = makeClient(); const game = consumer.sdk.createGameServices({ supabase });
  const raw = (path: string, body?: object, token?: string) => fetch(`${project.url}/functions/v1/supagame/v1${path}`, {
    method: body ? 'POST' : 'GET', headers: { apikey: key, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await t.test('starts staged assets, enables Auth and verifies schema/security using doctor', async () => {
    assert.match(cli('doctor', '--local'), /HEALTHY/);
    const listed = await raw('/leaderboards'); assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { id: string; sortDirection: string }[]).map(({ id, sortDirection }) => [id, sortDirection]).sort(), [['arcade', 'desc'], ['level-1', 'asc']]);
    assert.deepEqual(await game.leaderboards.getTop('level-1'), { entries: [], nextCursor: null });
    const player = await game.players.ensureAnonymousSession();
    assert.deepEqual(await game.players.ensureAnonymousSession(), player);
    assert.equal((await game.players.getMe()).playerId, player.userId);
    assert.equal((await game.players.updateMe({ displayName: 'First player' })).displayName, 'First player');
  });
  const userId = (await supabase.auth.getSession()).data.session!.user.id;
  const token = (await supabase.auth.getSession()).data.session!.access_token;
  await t.test('installed SDK saves JSON and binary data with revisions and private ownership', async () => {
    const first = await game.saves.save('profile', { level: 2 }, { schemaVersion: 3 });
    assert.equal(first.revision, 1);
    assert.deepEqual((await game.saves.load('profile')).data, { level: 2 });
    assert.equal((await game.saves.list())[0]?.schemaVersion, 3);
    await assert.rejects(game.saves.save('profile', {}, { expectedRevision: 0 }), { code: 'SAVE_CONFLICT' });
    const binary = await game.saves.saveBinary('rpg', new Blob(['rpg-data']));
    assert.equal(await (await game.saves.loadBinary('rpg')).data.text(), 'rpg-data');
    await game.saves.delete('rpg', { expectedRevision: binary.revision });
    await game.saves.cleanup();
    await game.saves.cleanup();
    const result = await raw('/saves/profile', undefined, token);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).save.revision, 1);
  });
  for (const [board, better, worse] of [['level-1', 40, 60], ['arcade', 60, 40]] as const) {
    await t.test(`${board}: best-only, equal scores, raw HTTP, replay, stable tied pagination`, async () => {
      assert.equal(await game.leaderboards.getMine(board), null);
      const submissionKey = crypto.randomUUID();
      const first = await game.leaderboards.submit(board, 50, submissionKey);
      assert.deepEqual(first, { outcome: 'best', score: 50, bestScore: 50 });
      assert.equal((await game.leaderboards.submit(board, better)).outcome, 'best');
      assert.deepEqual(await game.leaderboards.submit(board, 50, submissionKey), first);
      assert.equal((await game.leaderboards.submit(board, worse)).outcome, 'not_best');
      const mine = await game.leaderboards.getMine(board);
      assert.deepEqual(await game.leaderboards.submit(board, better), { outcome: 'not_best', score: better, bestScore: better });
      assert.deepEqual(await game.leaderboards.getMine(board), mine, 'Equal score retains achievement timestamp');
      await assert.rejects(game.leaderboards.submit(board, 51, submissionKey), { code: 'DUPLICATE_KEY_CONFLICT', status: 409 });
      const tied = makeClient(); const third = makeClient();
      for (const [client, value] of [[tied, better], [third, worse]] as const) {
        const signed = await client.auth.signInAnonymously(); assert.equal(signed.error, null);
        const response = await raw(`/leaderboards/${board}/scores`, { score: value, submissionKey: crypto.randomUUID() }, signed.data.session!.access_token);
        assert.equal(response.status, 200); assert.equal((await response.json()).outcome, 'best');
      }
      const firstPage = await game.leaderboards.getTop(board, { limit: 1 });
      const middle = await game.leaderboards.getTop(board, { limit: 1, cursor: firstPage.nextCursor! });
      const final = await game.leaderboards.getTop(board, { limit: 1, cursor: middle.nextCursor! });
      const rows = [...firstPage.entries, ...middle.entries, ...final.entries];
      assert.deepEqual(rows.map((entry) => entry.rank), [1, 1, 3]);
      assert.equal(new Set(rows.map((entry) => entry.playerId)).size, 3);
      assert.deepEqual(rows.map((entry) => entry.score), [better, better, worse]);
      assert.equal(rows[0]?.playerId, userId); assert.equal(final.nextCursor, null);
      const response = await raw(`/leaderboards/${board}/entries?limit=3`); assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).entries, rows);
      await assert.rejects(game.leaderboards.getTop(board === 'arcade' ? 'level-1' : 'arcade', { cursor: firstPage.nextCursor! }), { code: 'INVALID_CURSOR' });
    });
  }
  await t.test('invalid, forged and unauthenticated requests fail; protected tables remain read-only', async () => {
    for (const score of [-1, 1000001, 1.5, '50', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await raw('/leaderboards/arcade/scores', { score, submissionKey: crypto.randomUUID() }, token);
      assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_SCORE');
    }
    const forged = await raw('/leaderboards/arcade/scores', { score: 1, submissionKey: crypto.randomUUID(), playerId: 'someone-else' }, token);
    assert.equal(forged.status, 400); await forged.body?.cancel();
    const guest = await raw('/players/me'); assert.equal(guest.status, 401); await guest.body?.cancel();
    const invalidToken = await raw('/players/me', undefined, 'invalid'); assert.equal(invalidToken.status, 401); await invalidToken.body?.cancel();
    const missingKey = await fetch(`${project.url}/functions/v1/supagame/v1/leaderboards`); assert.equal(missingKey.status, 401); await missingKey.body?.cancel();
    for (const client of [makeClient(), supabase]) {
      for (const table of ['game_players', 'game_leaderboards', 'game_best_scores']) {
        const { error } = await client.from(table).delete().not(table === 'game_leaderboards' ? 'id' : 'user_id', 'is', null);
        assert.equal(error?.code, '42501');
      }
      const write = await client.from('game_best_scores').insert({ leaderboard_id: 'arcade', user_id: userId, score: 999 });
      assert.equal(write.error?.code, '42501');
      assert.ok((await client.from('game_players').select('hidden')).error);
      assert.ok((await client.schema('sg_private').from('game_submission_events').select('*')).error);
    }
  });
  await t.test('rate limit is enforced and retries do not spend quota', async () => {
    const client = makeClient(); const sdk = consumer.sdk.createGameServices({ supabase: client });
    await sdk.players.ensureAnonymousSession();
    const key = crypto.randomUUID(); const original = await sdk.leaderboards.submit('arcade', 1, key);
    for (let i = 0; i < 9; i++) await sdk.leaderboards.submit('arcade', 1);
    assert.deepEqual(await sdk.leaderboards.submit('arcade', 1, key), original);
    await assert.rejects(sdk.leaderboards.submit('arcade', 1), { status: 429, code: 'RATE_LIMITED' });
  });
  await t.test('an anonymous identity can add an email/password without losing scores (local confirmations disabled)', async () => {
    const updated = await supabase.auth.updateUser({ email: `e2e-${crypto.randomUUID()}@example.invalid`, password: `${crypto.randomUUID()}aA1!` });
    assert.equal(updated.error, null); assert.equal(updated.data.user?.id, userId);
    assert.equal(updated.data.user?.is_anonymous, false);
    assert.deepEqual(await game.players.ensureAnonymousSession(), { userId });
    assert.equal((await game.leaderboards.getMine('arcade'))?.score, 60);
  });
  await t.test('real Chromium consumer uses installed SDK, persists identity and ships no privileged credentials', async () => {
    const demo = join(consumer.root, 'demo'); cpSync(join(repo, 'examples/browser-demo'), demo, { recursive: true, filter: (source) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(source) && !/\/\.env(?:\.|$)/.test(source) });
    // Resolve the SDK from the clean consumer's node_modules, not workspace links.
    const env = { ...process.env, VITE_SUPABASE_URL: project.url, VITE_SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_SERVICE_ROLE_KEY: 'server-only-canary-do-not-ship', VITE_UNUSED_SECRET: 'unused-env-canary-do-not-ship' };
    run(process.execPath, [join(repo, 'examples/browser-demo/node_modules/vite/bin/vite.js'), 'build', demo], consumer.root, env);
    const bundle = files(join(demo, 'dist')).map((path) => readFileSync(path, 'utf8')).join('\n');
    for (const secret of ['server-only-canary-do-not-ship', 'unused-env-canary-do-not-ship', ...Object.entries(status).filter(([name]) => /SECRET|SERVICE_ROLE|JWT_SECRET|DB_URL/.test(name)).map(([, value]) => value)]) {
      if (secret) assert.ok(!bundle.includes(secret), 'Client bundle must not contain privileged configuration');
    }
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path.includes('..')) { response.writeHead(404).end(); return; }
      const file = join(demo, 'dist', path === '/' ? 'index.html' : path);
      try { response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(readFileSync(file)); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(project.browserPort, '127.0.0.1', resolve); });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${project.browserPort}`); await page.getByRole('status').filter({ hasText: 'Ready.' }).waitFor();
      const identity = await page.locator('#identity').textContent();
      await page.getByLabel('Display name').fill('Browser player'); await page.getByRole('button', { name: 'Save name' }).click();
      await page.getByRole('status').filter({ hasText: 'Display name saved.' }).waitFor();
      for (const [id, value] of [['level-1', '30'], ['arcade', '70']]) {
        await page.getByLabel('Leaderboard').selectOption(id!);
        await page.getByRole('status').filter({ hasText: 'Rankings refreshed.' }).waitFor();
        await page.getByLabel('Score', { exact: true }).fill(value!); await page.getByRole('button', { name: 'Submit score' }).click();
        await page.getByRole('status').filter({ hasText: 'New personal best.' }).waitFor();
        assert.match(await page.locator('#personal-best').innerText(), new RegExp(`Personal best: ${value}`));
      }
      await page.reload(); await page.getByRole('status').filter({ hasText: 'Ready.' }).waitFor();
      assert.equal(await page.locator('#identity').textContent(), identity);
      assert.equal(await page.getByLabel('Display name').inputValue(), 'Browser player');
      await page.getByLabel('Leaderboard').selectOption('arcade');
      await page.getByRole('status').filter({ hasText: 'Rankings refreshed.' }).waitFor();
      await page.getByLabel('Score', { exact: true }).fill('70');
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.getByRole('button', { name: 'Submit score' }).click();
        await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('#controls')!.disabled);
      }
      await page.getByRole('status').filter({ hasText: 'RATE_LIMITED' }).waitFor();
      // A definitive HTTP rejection must not trap the UI in an uncertain retry.
      await page.getByLabel('Leaderboard').selectOption('level-1');
      await page.getByRole('status').filter({ hasText: 'Rankings refreshed.' }).waitFor();
      await page.getByLabel('Score', { exact: true }).fill('20');
      await page.getByRole('button', { name: 'Submit score' }).click();
      await page.getByRole('status').filter({ hasText: 'New personal best.' }).waitFor();
    } finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  await t.test('installed Live Leaderboards receives a private database broadcast after a synthetic local best', async () => {
    const client = makeClient(); const sdk = consumer.sdk.createGameServices({ supabase: client });
    const player = await sdk.players.ensureAnonymousSession();
    let connected = false, initial = false, updated = false;
    const subscription = sdk.leaderboards.subscribe('arcade', {
      onStatus: status => { if (status === 'connected') connected = true; },
      onUpdate: page => { initial = true; updated = page.entries.some(e => e.playerId === player.userId && e.score === 999999); },
    });
    const wait = async (condition: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!condition()) { assert.ok(Date.now() < deadline, 'Local private Broadcast did not converge'); await new Promise(r => setTimeout(r, 50)); }
    };
    try {
      await wait(() => connected && initial);
      await sdk.leaderboards.submit('arcade', 999999);
      await wait(() => updated);
    } finally { subscription.unsubscribe(); await client.removeAllChannels(); }
  });

});

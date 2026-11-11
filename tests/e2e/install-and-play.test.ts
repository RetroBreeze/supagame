import { dashboardSession } from './dashboard-session.ts';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
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
    const diagnostic=spawnSync(consumer.cli,['doctor','--local','--workdir',project.root],{encoding:'utf8'});
    assert.equal(diagnostic.status,0,diagnostic.stdout);
    assert.match(diagnostic.stdout,/HEALTHY/);
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
  await t.test('installed packages retain and restore server JSON and binary revisions on a fresh installation', async () => {
    await game.saves.save('profile', {level: 3}, {expectedRevision: 1, backupExisting: true});
    assert.deepEqual((await game.saves.loadRevision('profile', 1)).data, {level: 2});
    const recovery = consumer.sdk.createGameServices({supabase}).saves;
    assert.equal((await recovery.listRevisions('profile')).length, 1);
    const id = crypto.randomUUID();
    assert.equal((await recovery.restoreRevision('profile', 1, {expectedRevision: 2, operationId: id})).revision, 3);
    assert.equal((await recovery.restoreRevision('profile', 1, {expectedRevision: 2, operationId: id})).revision, 3);
    await game.saves.saveBinary('recovery', new Blob(['original bytes']));
    await game.saves.saveBinary('recovery', new Blob(['replacement bytes']), {expectedRevision: 1, backupExisting: true});
    await game.saves.cleanup();
    assert.equal(await (await recovery.loadBinaryRevision('recovery', 1)).data.text(), 'original bytes');
    await recovery.restoreRevision('recovery', 1, {expectedRevision: 2});
    assert.equal(await (await recovery.loadBinary('recovery')).data.text(), 'original bytes');
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

  await t.test('optional Admin installs from tarball, resets with live refresh and rejects stale operations', async () => {
    cli('add','admin');
    project.supabase(['migration','up','--include-all']);
    assert.match(cli('admin','doctor','--local'), /restricted_execution/);
    const client = makeClient(); const sdk = consumer.sdk.createGameServices({supabase:client});
    const player = await sdk.players.ensureAnonymousSession();
    await sdk.leaderboards.submit('arcade',12345);
    let connected=false, empty=false;
    const sub=sdk.leaderboards.subscribe('arcade',{onStatus:s=>{connected ||= s==='connected';},onUpdate:p=>{empty=p.entries.length===0;}});
    const wait=async (condition:()=>boolean)=>{const deadline=Date.now()+15000;while(!condition()){assert.ok(Date.now()<deadline,'Admin broadcast convergence');await new Promise(r=>setTimeout(r,50));}};
    try {
      await wait(()=>connected);
      const before=cli('admin','leaderboard','inspect','arcade','--local','--json');
      cli('admin','leaderboard','reset','arcade','--local','--dry-run');
      assert.equal(cli('admin','leaderboard','inspect','arcade','--local','--json'),before);
      cli('admin','leaderboard','reset','arcade','--local','--yes','--reason','new competition','--operation-id','90000000-0000-4000-8000-000000000001','--expected-revision','0');
      await wait(()=>empty);
      assert.equal(await sdk.leaderboards.getMine('arcade'),null);
      cli('admin','leaderboard','reset','arcade','--local','--yes','--reason','new competition','--operation-id','90000000-0000-4000-8000-000000000001','--expected-revision','0');
      await sdk.leaderboards.submit('arcade',1);
      assert.equal((await sdk.leaderboards.getMine('arcade'))?.score,1);
      cli('admin','player','restrict',player.userId,'--local','--yes','--reason','test restriction');
      await assert.rejects(sdk.leaderboards.submit('arcade',2),(e:unknown)=>e instanceof consumer.sdk.ApiError && e.code==='PLAYER_RESTRICTED');
      cli('admin','player','reinstate',player.userId,'--local','--yes','--reason','appeal');
      await sdk.leaderboards.submit('arcade',2);
      const execute=promisify(execFile);
      const reset=(id:string)=>execute(consumer.cli,['admin','leaderboard','reset','arcade','--local','--yes','--reason','concurrent competition','--operation-id',id,'--expected-revision','1','--workdir',project.root]);
      const results=await Promise.allSettled([
        reset('90000000-0000-4000-8000-000000000002'),
        reset('90000000-0000-4000-8000-000000000003'),
        sdk.leaderboards.submit('arcade',3),
      ]);
      assert.equal(results.slice(0,2).filter(r=>r.status==='fulfilled').length,1,'one concurrent reset wins');
      assert.equal(results[2]?.status,'fulfilled','concurrent submission is accepted exactly once');
      const inspected=JSON.parse(cli('admin','leaderboard','inspect','arcade','--local','--json'));
      assert.equal(inspected[0].result.generation,3);
      const score=await sdk.leaderboards.getMine('arcade');
      assert.ok(score===null || score.score===3,'submission belongs wholly before or after reset');
    } finally {sub.unsubscribe();await client.removeAllChannels();}
  });

  await t.test('installed dashboard executes every Admin action through the isolated operator connection',async()=>{
    const dashboard=await dashboardSession(consumer.cli,project.root);
    try {
      const request=dashboard.request;
      const read=async(view:string,extra:Record<string,unknown>={})=>{const result=await request('/api/read',{view,...extra});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
      const preview=async(action:string,target:string)=>{const result=await request('/api/preview',{action,target});assert.equal(result.status,200);return result.body;};
      const execute=async(p:{id:string;target:string})=>request('/api/execute',{previewId:p.id,reason:'Isolated dashboard verification',confirmation:p.target});
      const apply=async(action:string,target:string)=>{const p=await preview(action,target);const result=await execute(p);assert.equal(result.status,200,JSON.stringify(result.body));return p;};
      const overview=await read('overview');assert.equal(overview.project.ref,'abcdefghijklmnopqrst');assert.equal(overview.project.environment,'local');assert.ok(overview.counts.leaderboards>=2);
      const client=makeClient(),sdk=consumer.sdk.createGameServices({supabase:client});const player=await sdk.players.ensureAnonymousSession();await sdk.leaderboards.submit('arcade',15);
      const page=await read('scores',{board:'arcade',search:player.userId});assert.equal(page.items.length,1);const score=page.items[0].id;
      await read('leaderboard',{target:'arcade'});await read('player',{target:player.userId});await read('score',{target:score});
      const hidden=await apply('score.hide',score);assert.equal(await sdk.leaderboards.getMine('arcade'),null);assert.equal((await execute(hidden)).body.replayed,true);
      await apply('score.restore',score);assert.equal((await sdk.leaderboards.getMine('arcade'))?.score,15);
      await apply('player.restrict',player.userId);await assert.rejects(sdk.leaderboards.submit('arcade',16));await apply('player.reinstate',player.userId);await sdk.leaderboards.submit('arcade',16);
      await apply('leaderboard.disable','arcade');await assert.rejects(sdk.leaderboards.submit('arcade',17));await apply('leaderboard.enable','arcade');await sdk.leaderboards.submit('arcade',17);
      assert.match(player.userId,/^[a-f0-9-]{36}$/);
      project.supabase(['db','query',`insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,created_at,best_score,generation) select '${player.userId}','arcade',gen_random_uuid(),1,'not_best',clock_timestamp()+n*interval '1 microsecond',17,(select generation from public.game_leaderboards where id='arcade') from generate_series(1,55)n`,'--yes']);
      const pageOne=await read('scores',{board:'arcade',search:player.userId});assert.equal(pageOne.items.length,50);assert.ok(pageOne.next);
      const pageTwo=await read('scores',{board:'arcade',search:player.userId,cursor:pageOne.next});assert.equal(pageTwo.items.length,8);assert.equal(pageTwo.next,null);
      assert.equal(new Set([...pageOne.items,...pageTwo.items].map((r:{id:string})=>r.id)).size,58);
      const first=await preview('leaderboard.reset','arcade'),stale=await preview('leaderboard.reset','arcade');assert.equal((await execute(first)).status,200);assert.equal((await execute(stale)).status,409);assert.equal(await sdk.leaderboards.getMine('arcade'),null);
      const audit=await read('audit');assert.ok(audit.some((a:{operation_id:string})=>a.operation_id===first.id));
      await client.removeAllChannels();
    }finally{await dashboard.close();}
    await assert.rejects(fetch(dashboard.url));
  });

});

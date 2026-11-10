import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGameServices, ApiError, AuthenticationError } from '../../packages/sdk-ts/src/index.js';
import { query } from '../db/local-sessions.ts';

// Fixed local fixture only. Status secrets stay in memory; only the publishable key is used.
const status = JSON.parse(execFileSync('node_modules/.bin/supabase', ['status', '--workdir', 'tests/fixtures/local', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { API_URL: string; PUBLISHABLE_KEY: string };
if (status.API_URL !== 'http://127.0.0.1:55431' || !status.PUBLISHABLE_KEY.startsWith('sb_publishable_')) throw new Error('SDK integration requires the dedicated local Supabase fixture.');
const makeClient = () => createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const supabase = makeClient();
const game = createGameServices({ supabase });
const boards = [`sdk-${crypto.randomUUID()}-asc`, `sdk-${crypto.randomUUID()}-desc`];
const users: string[] = [];
beforeAll(() => {
  query(`insert into public.game_leaderboards(id,kind,sort_direction,min_value,max_value,enabled) values ('${boards[0]}','time','asc',0,100,true),('${boards[1]}','points','desc',0,100,true)`);
});
afterAll(() => {
  query(`delete from public.game_leaderboards where id in ('${boards[0]}','${boards[1]}')`);
  for (const id of users) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid test user ID');
    query(`delete from auth.users where id='${id}'`);
  }
});
it('reads public boards without signing in and rejects protected calls without a session', async () => {
  expect(await game.leaderboards.getTop(boards[0]!)).toEqual({ entries: [], nextCursor: null });
  await expect(game.players.getMe()).rejects.toBeInstanceOf(AuthenticationError);
  expect((await supabase.auth.getSession()).data.session).toBeNull();
});
it('creates an anonymous Auth identity once, retrieves and updates its profile', async () => {
  const first = await game.players.ensureAnonymousSession(); users.push(first.userId);
  expect(await game.players.ensureAnonymousSession()).toEqual(first);
  expect((await supabase.auth.getSession()).data.session?.user.is_anonymous).toBe(true);
  expect((await game.players.getMe()).playerId).toBe(first.userId);
  expect((await game.players.updateMe({ displayName: 'SDK Player' })).displayName).toBe('SDK Player');
});
it('submits ASC/DESC personal bests and preserves SQL idempotency and validation', async () => {
  for (const [index, board] of boards.entries()) {
    const key = crypto.randomUUID();
    expect(await game.leaderboards.submit(board, 50, key)).toEqual({ outcome: 'best', score: 50, bestScore: 50 });
    expect(await game.leaderboards.submit(board, index === 0 ? 40 : 60)).toMatchObject({ outcome: 'best' });
    expect(await game.leaderboards.submit(board, 50, key)).toEqual({ outcome: 'best', score: 50, bestScore: 50 });
    await expect(game.leaderboards.submit(board, 51, key)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_KEY_CONFLICT', submissionKey: key });
    await expect(game.leaderboards.submit(board, 101)).rejects.toMatchObject({ status: 400, code: 'INVALID_SCORE' });
    expect(await game.leaderboards.getMine(board)).toMatchObject({ playerId: users[0], rank: 1, score: index === 0 ? 40 : 60 });
  }
});
it('uses a real refreshed Auth session and supports an explicit API URL', async () => {
  const refreshed = await supabase.auth.refreshSession();
  expect(refreshed.error).toBeNull();
  const override = createGameServices({ supabase, baseUrl: `${status.API_URL}/functions/v1/supagame/v1`, publishableKey: status.PUBLISHABLE_KEY });
  expect((await override.players.getMe()).playerId).toBe(users[0]);
});
it('reuses a permanent account and paginates real tied scores', async () => {
  const permanent = makeClient();
  const signed = await permanent.auth.signUp({ email: `sdk-${crypto.randomUUID()}@example.invalid`, password: `${crypto.randomUUID()}aA1!` });
  expect(signed.error).toBeNull();
  const id = signed.data.user!.id; users.push(id);
  const otherGame = createGameServices({ supabase: permanent });
  expect(await otherGame.players.ensureAnonymousSession()).toEqual({ userId: id });
  expect((await permanent.auth.getSession()).data.session?.user.is_anonymous).toBe(false);
  expect(await otherGame.leaderboards.getMine(boards[0]!)).toBeNull();
  await otherGame.leaderboards.submit(boards[0]!, 40);
  const first = await game.leaderboards.getTop(boards[0]!, { limit: 1 });
  expect(first.entries[0]?.rank).toBe(1); expect(first.nextCursor).not.toBeNull();
  const second = await game.leaderboards.getTop(boards[0]!, { limit: 1, cursor: first.nextCursor! });
  expect(second.entries[0]?.rank).toBe(1); expect(second.entries[0]?.playerId).not.toBe(first.entries[0]?.playerId);
  expect(second.nextCursor).toBeNull();
});
it('retains SQL direct-write restrictions and maps missing-board errors', async () => {
  const { error } = await supabase.from('game_best_scores').insert({ leaderboard_id: boards[0], user_id: users[0], score: 0 });
  expect(error).not.toBeNull(); expect(error?.code).toBe('42501');
  await expect(game.leaderboards.getTop('sdk-does-not-exist')).rejects.toBeInstanceOf(ApiError);
  await expect(game.leaderboards.getTop('sdk-does-not-exist')).rejects.toMatchObject({ status: 404, code: 'LEADERBOARD_NOT_FOUND' });
});
it('lets the real Supabase client refresh an expired persisted session before player requests', async () => {
  const existing = (await supabase.auth.getSession()).data.session!;
  const values = new Map<string, string>([['sdk-refresh-test', JSON.stringify({ ...existing, expires_at: 1 })]]);
  const restored = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: {
    storageKey: 'sdk-refresh-test', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } },
  } });
  expect((await createGameServices({ supabase: restored }).players.getMe()).playerId).toBe(users[0]);
  const refreshed = (await restored.auth.getSession()).data.session;
  expect(Boolean(refreshed && refreshed.expires_at! > Date.now() / 1000)).toBe(true);
  expect(Boolean(refreshed && refreshed.refresh_token !== existing.refresh_token)).toBe(true);
});

it('receives database Broadcast over a private channel and refreshes authoritative HTTP ranks', async () => {
  const pages: number[] = [];
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const subscription = game.leaderboards.subscribe(boards[1]!, {
    onUpdate: page => { pages.push(page.entries.find(e=>e.playerId===users[0])?.score ?? -1); },
    onStatus: value => { statuses.push(value); }, onError: error => errors.push(error),
  });
  try {
    await expect.poll(()=>statuses.includes('connected'),{timeout:10000}).toBe(true);
    await expect.poll(()=>pages.length,{timeout:10000}).toBeGreaterThan(0);
    await game.leaderboards.submit(boards[1]!,99);
    await expect.poll(()=>pages.at(-1),{timeout:10000}).toBe(99);
    expect(errors).toEqual([]);
  } finally { subscription.unsubscribe(); await supabase.removeAllChannels(); }
});

it('Cloud Saves round-trips JSON, detects races, isolates players and preserves binary versions', async () => {
  const slot=`save-${crypto.randomUUID()}`;
  const first=await game.saves.save(slot,{coins:4,nested:{score:1.5}},{schemaVersion:2});
  expect(first.revision).toBe(1);
  const otherTab=createGameServices({supabase});
  await otherTab.saves.load(slot);
  expect((await game.saves.save(slot,{coins:5},{expectedRevision:1})).revision).toBe(2);
  await expect(otherTab.saves.save(slot,{coins:6})).rejects.toMatchObject({code:'SAVE_CONFLICT',current:{revision:2,data:{coins:5}}});
  expect((await game.saves.list()).some(s=>s.slot===slot)).toBe(true);
  const other=makeClient(),otherGame=createGameServices({supabase:other});users.push((await otherGame.players.ensureAnonymousSession()).userId);
  await expect(otherGame.saves.load(slot)).rejects.toMatchObject({code:'SAVE_NOT_FOUND'});
  const direct=await other.from('game_saves').select('*');expect(direct.data).toEqual([]);
  const denied=await other.storage.from('supagame-saves').upload(`${users[0]}/${crypto.randomUUID()}`,new Blob(['no']));expect(denied.error).not.toBeNull();
  const binarySlot=`rpg-${crypto.randomUUID()}`,id=crypto.randomUUID();
  const binary=await game.saves.saveBinary(binarySlot,new Blob(['RPG save data']),{operationId:id,expectedRevision:0});
  expect(binary.revision).toBe(1);expect((await game.saves.loadBinary(binarySlot)).data.size).toBe(13);
  expect((await game.saves.saveBinary(binarySlot,new Blob(['RPG save data']),{operationId:id,expectedRevision:0})).revision).toBe(1);
  await expect(game.saves.saveBinary(binarySlot,new Blob(['RPG save datb']),{operationId:id,expectedRevision:0})).rejects.toMatchObject({code:'DUPLICATE_KEY_CONFLICT'});
  const read=await other.storage.from('supagame-saves').download(binary.objectPath!);expect(read.error).not.toBeNull();
  const remove=await supabase.storage.from('supagame-saves').remove([binary.objectPath!]);expect(remove.data??[]).toHaveLength(0);
  expect(await (await game.saves.loadBinary(binarySlot)).data.text()).toBe('RPG save data');
  const replacement=await game.saves.saveBinary(binarySlot,new Blob(['updated RPG data']),{expectedRevision:1});expect(replacement.revision).toBe(2);
  expect(await game.saves.cleanup()).toBeGreaterThanOrEqual(1);
  expect(await (await game.saves.loadBinary(binarySlot)).data.text()).toBe('updated RPG data');
  await game.saves.delete(binarySlot,{expectedRevision:2});await game.saves.cleanup();await game.saves.cleanup();
  await game.saves.delete(slot,{expectedRevision:2});await expect(game.saves.load(slot)).rejects.toMatchObject({code:'SAVE_NOT_FOUND'});
},30000);

it('recovers after upload succeeds but its acknowledgement or metadata commit is interrupted',async()=>{
 const slot=`interrupted-${crypto.randomUUID()}`,operationId=crypto.randomUUID(),blob=new Blob(['unfinished']);
 const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
 const request={operationId,expectedRevision:0,schemaVersion:1,metadata:{},sizeBytes:blob.size,checksum};
 const prepared=await supabase.rpc('sg_cloud_save',{p_action:'prepare',p_slot:slot,p_request:request});expect(prepared.error).toBeNull();
 const path=prepared.data.upload.path;
 expect((await supabase.storage.from('supagame-saves').upload(path,await blob.arrayBuffer(),{upsert:false,contentType:'application/octet-stream'})).error).toBeNull();
 const recovered=await game.saves.saveBinary(slot,blob,{operationId,expectedRevision:0});expect(recovered.revision).toBe(1);
 expect(await(await game.saves.loadBinary(slot)).data.text()).toBe('unfinished');
 await game.saves.delete(slot,{expectedRevision:1});await game.saves.cleanup();await game.saves.cleanup();
});

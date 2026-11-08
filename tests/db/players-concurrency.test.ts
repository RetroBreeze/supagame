// Real sessions in the dedicated local fixture; no connection strings or credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { PlayerProfile } from '../../packages/contracts/src/types.js';

const psqlArgs = [
  'exec', '-i', 'supabase_db_supagame-schema-tests',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
];

function query(sql: string): string {
  return execFileSync('docker', [...psqlArgs, '-c', sql], { encoding: 'utf8', timeout: 15_000 }).trim();
}

function session(sql: string) {
  const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { stdout: '', stderr: '', exited: false };
  child.stdout.on('data', (chunk: Buffer) => { state.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { state.stderr += chunk.toString(); });
  const finished = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      state.exited = true;
      if (code === 0) resolve(state.stdout);
      else reject(new Error(`Local psql exited ${code}: ${state.stderr}`));
    });
  });
  // Completion is awaited after lock inspection; do not emit an early unhandled rejection.
  void finished.catch(() => undefined);
  child.stdin.write(sql);
  return { child, state, finished };
}

async function waitUntil(condition: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description);
    await setTimeout(20);
  }
}

const cases = [
  { name: 'get/get', first: 'public.sg_get_my_profile()', second: 'public.sg_get_my_profile()', expected: null },
  { name: 'get/update', first: 'public.sg_get_my_profile()', second: "public.sg_update_my_profile('Second Name')", expected: 'Second Name' },
  { name: 'update/get', first: "public.sg_update_my_profile('First Name')", second: 'public.sg_get_my_profile()', expected: 'First Name' },
  { name: 'update/update', first: "public.sg_update_my_profile('First Name')", second: "public.sg_update_my_profile('Second Name')", expected: 'Second Name' },
];

for (const scenario of cases) {
  test(`concurrent first profile ${scenario.name}`, { timeout: 30_000 }, async () => {
    const userId = randomUUID();
    const applicationName = `sg-profile-race-${userId}`;
    const auth = `
      set statement_timeout = '10s';
      set idle_in_transaction_session_timeout = '10s';
      begin;
      set local role authenticated;
      set local request.jwt.claims = '{"sub":"${userId}","role":"authenticated","is_anonymous":true}';
    `;
    query(`insert into auth.users (id, is_anonymous) values ('${userId}', true)`);
    const first = session(`${auth} select ${scenario.first};\n\\echo PROFILE_READY\n`);
    let second: ReturnType<typeof session> | undefined;
    try {
      await waitUntil(() => {
        assert.ok(!first.state.exited, first.state.stderr || 'first session exited before holding the insert');
        return first.state.stdout.includes('PROFILE_READY');
      }, 'first session must create a profile inside its open transaction');
      const original = JSON.parse(first.state.stdout.split('\n')[0] ?? '') as PlayerProfile;
      second = session(`${auth}
        set local application_name = '${applicationName}';
        select ${scenario.second};
        commit;
      `);
      second.child.stdin.end();
      const waiter = second;
      await waitUntil(() => {
        assert.ok(!waiter.state.exited, waiter.state.stderr || 'second request completed without waiting for the first');
        return query(`select exists (
          select 1 from pg_stat_activity
          where application_name = '${applicationName}' and wait_event_type = 'Lock'
        )`) === 't';
      }, 'second request must actually contend on the uncommitted profile');

      first.child.stdin.end('commit;\n');
      const [, output] = await Promise.all([first.finished, second.finished]);
      const result = JSON.parse(output.trim()) as PlayerProfile;
      assert.equal(original.playerId, userId);
      assert.equal(result.playerId, userId);
      assert.equal(result.createdAt, original.createdAt);
      assert.equal(result.displayName, scenario.expected);
      assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'displayName', 'playerId']);
      assert.equal(query(`select count(*) from public.game_players where user_id = '${userId}'`), '1');
      assert.equal(query(`select hidden from public.game_players where user_id = '${userId}'`), 'f');
    } finally {
      if (!first.child.stdin.destroyed && !first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n');
      // Server timeouts bound failures; disconnect/rollback before deleting this test's user.
      await Promise.allSettled([first.finished, ...(second ? [second.finished] : [])]);
      query(`delete from auth.users where id = '${userId}'`);
    }
  });
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SubmitScoreResult } from '../../packages/contracts/src/types.js';
import { query, session, waitUntil } from './local-sessions.ts';

const cases = [
  { name: 'descending better then worse', direction: 'desc', first: 90, second: 10, best: 90, outcome: 'not_best' },
  { name: 'descending worse then better', direction: 'desc', first: 10, second: 90, best: 90, outcome: 'best' },
  { name: 'ascending better then worse', direction: 'asc', first: 10, second: 90, best: 10, outcome: 'not_best' },
  { name: 'ascending worse then better', direction: 'asc', first: 90, second: 10, best: 10, outcome: 'best' },
  { name: 'equal scores', direction: 'desc', first: 90, second: 90, best: 90, outcome: 'not_best' },
  { name: 'duplicate key and score', direction: 'desc', first: 90, second: 90, best: 90, outcome: 'best', duplicate: true },
  { name: 'conflicting duplicate key', direction: 'desc', first: 10, second: 90, best: 10, error: 'DUPLICATE_KEY_CONFLICT', duplicate: true },
  { name: 'last rate-limit slot', direction: 'desc', first: 90, second: 100, best: 90, error: 'RATE_LIMITED', seedCount: 9 },
  { name: 'duplicate retry at quota', direction: 'desc', first: 90, second: 90, best: 90, outcome: 'best', duplicate: true, seedCount: 9 },
  { name: 'first-time profile creation', direction: 'desc', first: 10, second: 90, best: 90, outcome: 'best', newProfile: true },
] as const;

for (const scenario of cases) {
  test(`concurrent score submissions: ${scenario.name}`, { timeout: 30_000 }, async () => {
    const userId = randomUUID();
    const boardId = `race-${randomUUID()}`;
    const applicationName = `sg-score-race-${userId}`;
    const firstKey = randomUUID();
    const duplicate = 'duplicate' in scenario && scenario.duplicate;
    const secondKey = duplicate ? firstKey : randomUUID();
    const seedCount = 'seedCount' in scenario ? scenario.seedCount : 0;
    const auth = `
      set statement_timeout = '10s';
      set idle_in_transaction_session_timeout = '10s';
      begin;
      set local role authenticated;
      set local request.jwt.claims = '{"sub":"${userId}","is_anonymous":true}';
    `;
    query(`
      insert into auth.users (id, is_anonymous) values ('${userId}', true);
      ${'newProfile' in scenario ? '' : `insert into public.game_players (user_id) values ('${userId}');`}
      insert into public.game_leaderboards (id, kind, sort_direction) values ('${boardId}', 'points', '${scenario.direction}');
    `);
    let first: ReturnType<typeof session> | undefined;
    let second: ReturnType<typeof session> | undefined;
    try {
      if (seedCount) query(`${auth}
        select public.sg_submit_score('${boardId}', 1, gen_random_uuid()) from generate_series(1, ${seedCount}); commit;
      `);
      // Begin before this wall-clock marker, so transaction-start timestamps fail.
      first = session(`${auth}\n\\echo TRANSACTION_READY\n`);
      const holder = first;
      await waitUntil(() => holder.state.stdout.includes('TRANSACTION_READY'), 'first transaction must start');
      const earliestEvent = query('select clock_timestamp()');
      first.child.stdin.write(`select public.sg_submit_score('${boardId}', ${scenario.first}, '${firstKey}');\n\\echo SCORE_READY\n`);
      await waitUntil(() => {
        assert.ok(!holder.state.exited, holder.state.stderr);
        return holder.state.stdout.includes('SCORE_READY');
      }, 'first request must finish inside an open transaction');
      const original = JSON.parse(first.state.stdout.split('\n')[1] ?? '') as SubmitScoreResult;
      assert.deepEqual(original, { outcome: 'best', score: scenario.first, bestScore: scenario.first });
      second = session(`${auth}
        set local application_name = '${applicationName}';
        select public.sg_submit_score('${boardId}', ${scenario.second}, '${secondKey}'); commit;
      `);
      second.child.stdin.end();
      const waiter = second;
      await waitUntil(() => {
        assert.ok(!waiter.state.exited, waiter.state.stderr || 'competing request completed before the first committed');
        return query(`select exists (select 1 from pg_stat_activity
          where application_name = '${applicationName}' and wait_event_type = 'Lock')`) === 't';
      }, 'competing request must wait on the uncommitted submission');
      first.child.stdin.end('commit;\n');
      await first.finished;
      if ('error' in scenario) await assert.rejects(second.finished, new RegExp(scenario.error));
      else assert.deepEqual(JSON.parse((await second.finished).trim()) as SubmitScoreResult,
        { outcome: scenario.outcome, score: scenario.second, bestScore: scenario.best });
      assert.equal(query(`select count(*) || ':' || min(score) from public.game_best_scores where leaderboard_id = '${boardId}'`), `1:${scenario.best}`);
      assert.equal(query(`select count(*) from public.game_players where user_id = '${userId}'`), '1');
      const events = seedCount + (duplicate || 'error' in scenario ? 1 : 2);
      assert.equal(query(`select count(*) from sg_private.game_submission_events where leaderboard_id = '${boardId}'`), String(events));
      assert.equal(query(`select created_at >= '${earliestEvent}'::timestamptz from sg_private.game_submission_events
        where leaderboard_id = '${boardId}' and submission_key = '${firstKey}'`), 't', 'event time must reflect processing, not transaction start');
      if (scenario.best === scenario.first) {
        assert.equal(query(`select submission_key from public.game_best_scores where leaderboard_id = '${boardId}'`), firstKey);
      }
    } finally {
      if (first && !first.child.stdin.destroyed && !first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n');
      await Promise.allSettled([...(first ? [first.finished] : []), ...(second ? [second.finished] : [])]);
      query(`delete from auth.users where id = '${userId}'; delete from public.game_leaderboards where id = '${boardId}';`);
    }
  });
}

for (const isolation of ['repeatable read', 'serializable']) {
  test(`score submission rejects stale-snapshot isolation: ${isolation}`, { timeout: 15_000 }, async () => {
    const userId = randomUUID();
    query(`insert into auth.users (id, is_anonymous) values ('${userId}', true)`);
    const request = session(`begin isolation level ${isolation};
      set local role authenticated;
      set local request.jwt.claims = '{"sub":"${userId}"}';
      select public.sg_submit_score('any-board', 1, gen_random_uuid()); commit;
    `);
    request.child.stdin.end();
    try {
      await assert.rejects(request.finished, /READ_COMMITTED_REQUIRED/);
      assert.equal(query(`select count(*) from public.game_players where user_id = '${userId}'`), '0');
    } finally {
      await Promise.allSettled([request.finished]);
      query(`delete from auth.users where id = '${userId}'`);
    }
  });
}

// A lock for one pair must not turn the limit into a global/player-wide lock.
for (const other of ['board', 'player']) {
  test(`unrelated ${other} can submit while another pair is uncommitted`, { timeout: 30_000 }, async () => {
    const firstUser = randomUUID();
    const secondUser = randomUUID();
    const firstBoard = `independent-${randomUUID()}`;
    const secondBoard = `independent-${randomUUID()}`;
    const auth = (user: string) => `set statement_timeout = '5s'; set idle_in_transaction_session_timeout = '10s';
      begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${user}"}';`;
    query(`insert into auth.users (id) values ('${firstUser}'), ('${secondUser}');
      insert into public.game_players (user_id) values ('${firstUser}'), ('${secondUser}');
      insert into public.game_leaderboards (id, kind, sort_direction) values
        ('${firstBoard}', 'points', 'desc'), ('${secondBoard}', 'points', 'desc');`);
    const first = session(`${auth(firstUser)} select public.sg_submit_score('${firstBoard}', 10, gen_random_uuid());\n\\echo SCORE_READY\n`);
    let second: ReturnType<typeof session> | undefined;
    try {
      await waitUntil(() => first.state.stdout.includes('SCORE_READY'), 'first pair must hold its transaction open');
      second = session(`${auth(other === 'player' ? secondUser : firstUser)}
        select public.sg_submit_score('${other === 'board' ? secondBoard : firstBoard}', 20, gen_random_uuid()); commit;`);
      second.child.stdin.end();
      assert.deepEqual(JSON.parse((await second.finished).trim()) as SubmitScoreResult,
        { outcome: 'best', score: 20, bestScore: 20 });
      assert.equal(first.state.exited, false, 'first transaction is still open');
    } finally {
      if (!first.child.stdin.destroyed && !first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n');
      await Promise.allSettled([first.finished, ...(second ? [second.finished] : [])]);
      query(`delete from auth.users where id in ('${firstUser}', '${secondUser}');
        delete from public.game_leaderboards where id in ('${firstBoard}', '${secondBoard}');`);
    }
  });
}

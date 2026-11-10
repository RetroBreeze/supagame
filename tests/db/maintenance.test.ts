// All mutations below are synthetic drift inside rolled-back local transactions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { securityChecks, securityQuery } from '../../packages/cli/src/lib/doctor-security.ts';
import { doctor, doctorExitCode } from '../../packages/cli/src/commands/doctor.ts';
import { runSupabase } from '../../packages/cli/src/lib/supabase-cli.ts';
import { templateFiles } from '../../packages/cli/src/lib/templates.ts';
import { currentInventory } from '../../packages/cli/src/lib/versions.ts';
import { cli, initialized, project, put, snapshot } from '../cli/project-fixture.ts';
import { execFileSync } from 'node:child_process';
const checks = securityChecks(['core', 'leaderboards', 'live-leaderboards', 'achievements']);
function inspect(setup = ''): { check: string; ok: boolean }[] {
  return JSON.parse(
    execFileSync('docker', ['exec', '-i', 'supabase_db_supagame-schema-tests', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-c', `begin; ${setup} select jsonb_agg(result) from (${securityQuery(checks)}) result; rollback;`], { encoding: 'utf8', timeout: 15000 }),
  );
}
test('catalog diagnostics accept the actual installed schema, policies, column grants and RPC grants', () => {
  assert.deepEqual(inspect().filter((r) => !r.ok), []);
});
for (
  const [sql, id] of [
    ["alter policy achievements_own on public.game_player_achievements using (true);", 'policies:achievements'],
    ["grant update(threshold) on public.game_achievements to authenticated;", 'writes:authenticated:game_achievements'],
    ['grant update(score) on public.game_best_scores to anon;', 'writes:anon:game_best_scores'],
    [
      'grant delete on public.game_leaderboards to public;',
      'writes:authenticated:game_leaderboards',
    ],
    ["alter policy supagame_live_receive on realtime.messages using (true);", 'live:authorization'],
    ["grant execute on function sg_private.live_invalidate() to anon;", 'live:trigger'],
    ["drop trigger supagame_live_scores on public.game_best_scores; create trigger supagame_live_scores before insert on public.game_leaderboards for each row execute function sg_private.live_invalidate();", 'live:triggers'],
    ["create policy unrelated_broad_receive on realtime.messages for select to authenticated using (true);", 'live:other-policies'],
    ["alter table realtime.messages disable row level security;", 'live:realtime-rls'],
    ["revoke select on realtime.messages from authenticated;", 'live:receive-grants'],

    ["alter table public.game_best_scores disable trigger supagame_live_scores;", 'live:triggers'],
    ['alter table public.game_players disable row level security;', 'rls:public.game_players'],
    [
      'alter policy game_players_visible_read on public.game_players using (true);',
      'policies:public.game_players',
    ],
    [
      'create policy wrong_write on public.game_best_scores for insert to anon with check (true);',
      'policies:public.game_best_scores',
    ],
    [
      'grant select(submission_key) on public.game_best_scores to anon;',
      'reads:anon:game_best_scores',
    ],
    ['grant usage on schema sg_private to authenticated;', 'private-schema:authenticated'],
    [
      'grant execute on function public.sg_submit_score(text,bigint,uuid) to public;',
      'execute:sg_submit_score',
    ],
    [
      'alter function public.sg_get_my_profile() set search_path = public;',
      'function:sg_get_my_profile',
    ],
    ['drop function public.sg_get_my_score(text);', 'function:sg_get_my_score'],
  ] as const
) {
  test(`detects ${id} drift without leaving fixture changes`, () => {
    assert.equal(inspect(sql).find((r) => r.check === id)?.ok, false);
    assert.equal(inspect().find((r) => r.check === id)?.ok, true);
  });
}
test('actual local CLI doctor is read-only and verifies migration ledger and catalog queries', async () => {
  const root = project();
  try {
    put(
      root,
      'supabase/config.toml',
      'project_id = "supagame-schema-tests"\n[db]\nport = 55432\n[auth]\nenable_anonymous_sign_ins = true\n',
    );
    initialized(root);
    const install = cli(root, 'add', 'live-leaderboards');
    assert.equal(install.status, 0, install.stderr);
    assert.equal(cli(root, 'add', 'achievements').status, 0);
    const before = snapshot(root);
    const findings = await doctor({ workdir: root, local: true }, {
      run: runSupabase,
      log: () => {},
      inventory: currentInventory(templateFiles()),
    });
    assert.equal(
      doctorExitCode(findings, true),
      0,
      JSON.stringify(findings.filter((f) => f.status !== 'healthy')),
    );
    assert.ok(findings.some((f) => f.id === 'schema:core' && f.status === 'healthy'));
    assert.ok(
      findings.some((f) => f.id === 'writes:anon:game_best_scores' && f.status === 'healthy'),
    );
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

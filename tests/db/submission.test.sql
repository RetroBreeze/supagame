-- Local fixture only; every user, event, score and temporary grant rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select has_function('public', 'sg_submit_score', array['text', 'bigint', 'uuid'], 'submission RPC exists');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sg_submit_score'), 1::bigint, 'no player-ID overload');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid = to_regprocedure('public.sg_submit_score(text,bigint,uuid)')), 'definer has an empty search_path');
select is((select prorettype from pg_proc where oid = to_regprocedure('public.sg_submit_score(text,bigint,uuid)')),
  'jsonb'::regtype::oid, 'returns JSONB');
select ok(has_function_privilege('authenticated', 'public.sg_submit_score(text,bigint,uuid)', 'EXECUTE'), 'player sessions may submit');
select ok(not has_function_privilege(r, 'public.sg_submit_score(text,bigint,uuid)', 'EXECUTE'), r || ' cannot execute')
from (values ('anon'), ('service_role')) as roles(r);
select is((select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a
  where p.oid = to_regprocedure('public.sg_submit_score(text,bigint,uuid)') and a.grantee = 0), 0::bigint, 'no PUBLIC execute');
select col_type_is('sg_private', 'game_submission_events', 'best_score', 'bigint', 'original best is retained for replay');
select col_not_null('sg_private', 'game_submission_events', 'best_score', 'every event has its original best');

-- Short deterministic keys keep scenarios readable; this helper is invoker-scoped.
create function pg_temp.submit(board text, score bigint, key integer) returns jsonb
language sql as $$ select public.sg_submit_score(board, score,
  ('40000000-0000-4000-8000-' || lpad(key::text, 12, '0'))::uuid) $$;
insert into auth.users (id, is_anonymous) values
  ('40000000-0000-4000-8000-000000000001', true),
  ('40000000-0000-4000-8000-000000000002', false);
insert into public.game_leaderboards (id, kind, sort_direction, min_value, max_value, enabled) values
  ('submit-desc', 'points', 'desc', 0, 100, true),
  ('submit-asc', 'time', 'asc', 0, 100, true),
  ('submit-off', 'points', 'desc', null, null, false),
  ('submit-safe', 'points', 'desc', null, null, true),
  ('submit-rate', 'points', 'desc', null, null, true);

set local role anon;
select throws_ok($$select pg_temp.submit('submit-desc', 10, 1)$$, '42501', null, 'guest role cannot submit');
reset role;
set local role authenticated;
select throws_ok($$select pg_temp.submit('submit-desc', 10, 1)$$, '28000', 'UNAUTHORIZED', 'subject is mandatory');
set local request.jwt.claims = '{"sub":"invalid"}';
select throws_ok($$select pg_temp.submit('submit-desc', 10, 1)$$, '28000', 'UNAUTHORIZED', 'malformed subject fails closed');
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000099"}';
select throws_ok($$select pg_temp.submit('submit-desc', 10, 1)$$, '28000', 'UNAUTHORIZED', 'nonexistent Auth identity fails closed');
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000001","is_anonymous":true}';

select throws_ok($$select pg_temp.submit('missing', 10, 1)$$, 'P0002', 'LEADERBOARD_NOT_FOUND', 'nonexistent board rejected');
select throws_ok($$select pg_temp.submit('submit-off', 10, 1)$$, 'P0002', 'LEADERBOARD_NOT_FOUND', 'disabled board rejected');
select throws_ok($$select pg_temp.submit(null, 10, 1)$$, '22023', 'INVALID_REQUEST', 'null board rejected');
select throws_ok($$select public.sg_submit_score('submit-desc', 10, null)$$, '22023', 'INVALID_REQUEST', 'null key rejected');
select throws_ok($$select pg_temp.submit('submit-desc', null, 1)$$, '22023', 'INVALID_SCORE', 'null score rejected');
select throws_ok(format('select pg_temp.submit(''submit-desc'', %s, 1)', score), '22023', 'INVALID_SCORE', 'configured bounds reject ' || score)
from (values (-1), (101)) as inputs(score);
select throws_ok(format('select pg_temp.submit(''submit-safe'', %s, 1)', score), '22023', 'INVALID_SCORE', 'JSON-unsafe score rejected')
from (values (-9007199254740992::bigint), (9007199254740992::bigint)) as inputs(score);
reset role;
select is_empty('select * from public.game_players', 'rejected first attempts create no profiles');
select is_empty('select * from sg_private.game_submission_events', 'rejected attempts consume no quota');

set local role authenticated;
select is(pg_temp.submit('submit-desc', 10, 1), '{"outcome":"best","score":10,"bestScore":10}'::jsonb, 'anonymous first score is best');
select is(pg_temp.submit('submit-desc', 20, 2), '{"outcome":"best","score":20,"bestScore":20}'::jsonb, 'larger descending score improves');
reset role;
create temporary table saved_best as select * from public.game_best_scores where leaderboard_id = 'submit-desc';
set local role authenticated;
select is(pg_temp.submit('submit-desc', 5, 3), '{"outcome":"not_best","score":5,"bestScore":20}'::jsonb, 'worse descending score does not improve');
select is(pg_temp.submit('submit-desc', 20, 4), '{"outcome":"not_best","score":20,"bestScore":20}'::jsonb, 'equal descending score does not improve');
reset role;
select results_eq('select * from public.game_best_scores where leaderboard_id = ''submit-desc''', 'select * from saved_best', 'worse/equal preserve score, timestamp and original key');
set local role authenticated;
select is(pg_temp.submit('submit-desc', 30, 5) ->> 'outcome', 'best', 'later improvement accepted');
select is(pg_temp.submit('submit-desc', 10, 1), '{"outcome":"best","score":10,"bestScore":10}'::jsonb, 'replay returns original best result after later improvement');
select is(pg_temp.submit('submit-desc', 5, 3), '{"outcome":"not_best","score":5,"bestScore":20}'::jsonb, 'not_best replay retains original bestScore');
select throws_ok($$select pg_temp.submit('submit-desc', 11, 1)$$, '23505', 'DUPLICATE_KEY_CONFLICT', 'key cannot be reused with a different score');
select is(pg_temp.submit('submit-desc', 0, 6) ->> 'outcome', 'not_best', 'minimum bound inclusive');
select is(pg_temp.submit('submit-desc', 100, 7) ->> 'outcome', 'best', 'maximum bound inclusive');
select is(pg_temp.submit('submit-asc', 50, 1), '{"outcome":"best","score":50,"bestScore":50}'::jsonb, 'same key on another board is independent');
select is(pg_temp.submit('submit-asc', 40, 2), '{"outcome":"best","score":40,"bestScore":40}'::jsonb, 'smaller ascending score improves');
select is(pg_temp.submit('submit-asc', 60, 3), '{"outcome":"not_best","score":60,"bestScore":40}'::jsonb, 'larger ascending score does not improve');
select is(pg_temp.submit('submit-asc', 40, 4), '{"outcome":"not_best","score":40,"bestScore":40}'::jsonb, 'equal ascending score does not improve');
select is(pg_temp.submit('submit-safe', -9007199254740991, 1) ->> 'score', '-9007199254740991', 'minimum safe integer accepted without configured bounds');
select is(pg_temp.submit('submit-safe', 9007199254740991, 2) ->> 'score', '9007199254740991', 'maximum safe integer accepted');
reset role;
select is((select count(*) from public.game_players), 1::bigint, 'submission creates exactly one profile');
select is((select count(*) from sg_private.game_submission_events where leaderboard_id = 'submit-desc'), 7::bigint, 'retries/conflicts produce no extra events');
select is((select count(*) from public.game_best_scores where leaderboard_id = 'submit-desc'), 1::bigint, 'exactly one personal best');
select throws_ok('update sg_private.game_submission_events set best_score = 9007199254740992', '23514', null, 'stored replay best must also be JSON safe');

-- Replays precede mutable board validation: a completed request stays completed.
update public.game_leaderboards set enabled = false, max_value = 1 where id = 'submit-desc';
set local role authenticated;
select is(pg_temp.submit('submit-desc', 5, 3), '{"outcome":"not_best","score":5,"bestScore":20}'::jsonb, 'replay survives board disable/bounds changes');
select throws_ok($$select pg_temp.submit('submit-desc', 0, 8)$$, 'P0002', 'LEADERBOARD_NOT_FOUND', 'new request on disabled board fails');

select is(pg_temp.submit('submit-rate', 10, n) ->> 'outcome', case when n = 1 then 'best' else 'not_best' end, 'quota accepts submission ' || n)
from generate_series(1, 10) as n;
select throws_ok($$select pg_temp.submit('submit-rate', 11, 11)$$, 'P0001', 'RATE_LIMITED', '11th request rejected');
select is(pg_temp.submit('submit-rate', 10, 1), '{"outcome":"best","score":10,"bestScore":10}'::jsonb, 'replay is allowed at the quota');
select throws_ok($$select pg_temp.submit('submit-rate', 11, 1)$$, '23505', 'DUPLICATE_KEY_CONFLICT', 'conflict takes precedence over quota');
reset role;
select is((select count(*) from sg_private.game_submission_events where leaderboard_id = 'submit-rate'), 10::bigint, 'rejection/retry did not increase quota');
select is((select score from public.game_best_scores where leaderboard_id = 'submit-rate'), 10::bigint, 'throttled improvement did not change best');
-- An old event expires from the rolling window but retains its replay result.
update sg_private.game_submission_events set created_at = clock_timestamp() - interval '61 seconds'
where leaderboard_id = 'submit-rate' and submission_key = '40000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(pg_temp.submit('submit-rate', 11, 11) ->> 'outcome', 'best', 'window expiry frees exactly one slot');
select throws_ok($$select pg_temp.submit('submit-rate', 12, 12)$$, 'P0001', 'RATE_LIMITED', 'ten recent events still enforce the rolling limit');
select is(pg_temp.submit('submit-rate', 10, 1), '{"outcome":"best","score":10,"bestScore":10}'::jsonb, 'old retry remains idempotent outside rate window');
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000002","is_anonymous":false}';
select is(pg_temp.submit('submit-rate', 99, 1), '{"outcome":"best","score":99,"bestScore":99}'::jsonb, 'permanent user has independent quota and keys');
select throws_ok($$select public.sg_submit_score('submit-rate', 100, gen_random_uuid(), '40000000-0000-4000-8000-000000000001'::uuid)$$,
  '42883', null, 'cannot supply another player identity');
select throws_ok('update public.game_best_scores set score = 100', '42501', null, 'direct score updates remain denied');
select throws_ok('select * from sg_private.game_submission_events', '42501', null, 'private replay data remains inaccessible');
reset role;
select is((select score from public.game_best_scores where leaderboard_id = 'submit-rate' and user_id = '40000000-0000-4000-8000-000000000001'), 11::bigint, 'other player best preserved');

-- Hostile caller search paths cannot redirect reads or writes.
create temporary table game_best_scores (like public.game_best_scores including all);
create temporary table game_submission_events (like sg_private.game_submission_events including all);
grant all on pg_temp.game_best_scores, pg_temp.game_submission_events to authenticated;
set local search_path = pg_temp, public, extensions;
set local role authenticated;
select is(pg_temp.submit('submit-asc', 30, 1), '{"outcome":"best","score":30,"bestScore":30}'::jsonb, 'qualified references ignore shadow tables');
reset role;
select is_empty('select * from pg_temp.game_best_scores', 'no writes to caller-controlled score table');
select is_empty('select * from pg_temp.game_submission_events', 'no writes to caller-controlled event table');
update public.game_players set hidden = true where user_id = '40000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(pg_temp.submit('submit-asc', 20, 2) ->> 'outcome', 'best', 'hidden owner may still submit');
select is_empty($$select user_id from public.game_best_scores where user_id = '40000000-0000-4000-8000-000000000002'$$, 'hidden scores stay excluded from public reads');
reset role;
select is((select hidden from public.game_players where user_id = '40000000-0000-4000-8000-000000000002'), true, 'submission cannot unhide a player');
select * from finish();
rollback;

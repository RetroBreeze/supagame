-- Local-only fixtures, grants and helper functions all roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone = 'UTC';
select no_plan();

select has_function('public', 'sg_list_leaderboards', array[]::text[], 'board listing exists');
select has_function('public', 'sg_get_entries', array['text', 'integer', 'jsonb'], 'entry paging exists');
select has_function('public', 'sg_get_my_score', array['text'], 'personal standing exists');
select ok((select not prosecdef and provolatile = 's' and proconfig @> array['search_path=""']
  from pg_proc where oid = to_regprocedure(signature)), signature || ' is stable, invoker-scoped and has a safe path')
from (values ('public.sg_list_leaderboards()'), ('public.sg_get_entries(text,integer,jsonb)'), ('public.sg_get_my_score(text)')) as funcs(signature);
select ok(has_function_privilege('authenticated', signature, 'EXECUTE'), 'authenticated can execute ' || signature)
from (values ('public.sg_list_leaderboards()'), ('public.sg_get_entries(text,integer,jsonb)'), ('public.sg_get_my_score(text)')) as funcs(signature);
select ok(not has_function_privilege('service_role', signature, 'EXECUTE'), 'no service-role grant for ' || signature)
from (values ('public.sg_list_leaderboards()'), ('public.sg_get_entries(text,integer,jsonb)'), ('public.sg_get_my_score(text)')) as funcs(signature);
select is((select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a
  where p.oid in (to_regprocedure('public.sg_list_leaderboards()'), to_regprocedure('public.sg_get_entries(text,integer,jsonb)'), to_regprocedure('public.sg_get_my_score(text)'))
    and a.grantee = 0), 0::bigint, 'PUBLIC has no execute grants');

set local role anon;
select is(public.sg_list_leaderboards(), '[]'::jsonb, 'no configured boards returns an empty array');
select throws_ok($$select public.sg_get_my_score('rank-asc')$$, '42501', null, 'guest cannot request a personal standing');
reset role;

insert into auth.users (id, is_anonymous)
select ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, n <> 4 from generate_series(1, 7) n;
insert into public.game_players (user_id, display_name, hidden)
select id, case when right(id::text, 1) = '1' then null else 'Player ' || right(id::text, 1) end,
  right(id::text, 1) = '6' from auth.users;
insert into public.game_leaderboards (id, kind, sort_direction, min_value, max_value, enabled) values
  ('rank-asc', 'time', 'asc', 0, 100, true), ('rank-desc', 'points', 'desc', null, null, true),
  ('rank-empty', 'points', 'desc', null, null, true), ('rank-single', 'time', 'asc', null, null, true),
  ('rank-off', 'points', 'desc', null, null, false);
insert into public.game_best_scores (leaderboard_id, user_id, score, achieved_at, submission_key)
select board, ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  case when board = 'rank-desc' and n = 6 then 100 else score end,
  '2026-01-01T00:00:00.123456Z'::timestamptz + seconds * interval '1 second', gen_random_uuid()
from (values (1, 10, 2), (2, 10, 1), (3, 10, 1), (4, 20, 0), (5, 30, 0), (6, 0, 0)) as scores(n, score, seconds)
cross join (values ('rank-asc'), ('rank-desc')) as boards(board);
insert into public.game_best_scores (leaderboard_id, user_id, score, achieved_at, submission_key)
values ('rank-single', '50000000-0000-4000-8000-000000000001', 10, '2026-01-01T00:00:02.123456Z', gen_random_uuid()),
  ('rank-off', '50000000-0000-4000-8000-000000000002', 1, now(), gen_random_uuid());

create function pg_temp.expected_entry(n integer, score bigint, rank bigint, seconds integer) returns jsonb language sql as $$
  select jsonb_build_object('playerId', '50000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'displayName', case when n = 1 then null else 'Player ' || n end,
    'score', score, 'rank', rank, 'achievedAt', '2026-01-01T00:00:00.123456Z'::timestamptz + seconds * interval '1 second')
$$;
create function pg_temp.expected_entries(board text) returns jsonb language sql as $$
  select case when board = 'rank-asc' then jsonb_build_array(
    pg_temp.expected_entry(2,10,1,1), pg_temp.expected_entry(3,10,1,1), pg_temp.expected_entry(1,10,1,2),
    pg_temp.expected_entry(4,20,4,0), pg_temp.expected_entry(5,30,5,0))
  else jsonb_build_array(pg_temp.expected_entry(5,30,1,0), pg_temp.expected_entry(4,20,2,0),
    pg_temp.expected_entry(2,10,3,1), pg_temp.expected_entry(3,10,3,1), pg_temp.expected_entry(1,10,3,2)) end
$$;
create function pg_temp.check_pages(board text, page_size integer) returns setof text language plpgsql as $$
declare page jsonb; cursor_value jsonb; entries jsonb := '[]'; calls integer := 0;
begin
  loop
    page := public.sg_get_entries(board, page_size, cursor_value);
    calls := calls + 1;
    if calls > 6 then raise exception 'pagination did not terminate'; end if;
    return query select ok(jsonb_array_length(page->'entries') between 1 and page_size, 'each page respects its limit');
    entries := entries || (page->'entries');
    exit when page->'nextCursor' = 'null'::jsonb;
    return query select is(jsonb_typeof(page->'nextCursor'), 'string', 'nextCursor matches the public string contract');
    cursor_value := (page->>'nextCursor')::jsonb;
    return query select is(cursor_value, jsonb_build_object('boardId', board,
      'score', page->'entries'->-1->'score', 'achievedAt', page->'entries'->-1->'achievedAt',
      'playerId', page->'entries'->-1->'playerId'), 'cursor contains exactly the last entry and originating board');
  end loop;
  return query select is(entries, pg_temp.expected_entries(board), board || ' pagination preserves every entry and global competition rank at limit ' || page_size);
  return query select is(calls, (5 + page_size - 1) / page_size, 'first/middle/final pages have no empty trailing page');
end $$;

-- Run the public contract under BOTH API roles, so owner bypass cannot hide RLS errors.
create function pg_temp.public_reads() returns setof text language plpgsql as $$
begin
  return query select is(public.sg_list_leaderboards(), '[
    {"id":"rank-asc","kind":"time","sortDirection":"asc","minValue":0,"maxValue":100},
    {"id":"rank-desc","kind":"points","sortDirection":"desc","minValue":null,"maxValue":null},
    {"id":"rank-empty","kind":"points","sortDirection":"desc","minValue":null,"maxValue":null},
    {"id":"rank-single","kind":"time","sortDirection":"asc","minValue":null,"maxValue":null}]'::jsonb, 'list is ordered and exposes only enabled board DTOs');
  return query select is(public.sg_get_entries('rank-empty'), '{"entries":[],"nextCursor":null}'::jsonb, 'empty board has no cursor');
  return query select is(public.sg_get_entries('rank-single'), jsonb_build_object('entries', jsonb_build_array(pg_temp.expected_entry(1,10,1,2)), 'nextCursor', null), 'single player is rank one with exact public fields');
  return query select is(public.sg_get_entries(board), jsonb_build_object('entries', pg_temp.expected_entries(board), 'nextCursor', null), board || ' sorts score, time, UUID and excludes hidden players before ranking')
    from (values ('rank-asc'), ('rank-desc')) as boards(board);
  return query select checks.result from (values ('rank-asc'), ('rank-desc')) as boards(board)
    cross join (values (1), (2), (3), (4), (5), (50), (100)) as sizes(page_size)
    cross join lateral pg_temp.check_pages(board, page_size) as checks(result);
  return query select throws_ok(format('select public.sg_get_entries(''rank-asc'', %L)', page_size), '22023', 'INVALID_REQUEST', 'invalid limit rejected')
    from (values (null::integer), (-1), (0), (101), (2147483647)) as sizes(page_size);
  return query select throws_ok(format('select public.sg_get_entries(%L)', board), 'P0002', 'LEADERBOARD_NOT_FOUND', 'missing/disabled board rejected')
    from (values ('missing'), ('rank-off'), (null::text), ('')) as boards(board);
  return query select throws_ok($q$select public.sg_get_entries('rank-desc', 2,
    (public.sg_get_entries('rank-asc', 2)->>'nextCursor')::jsonb)$q$, '22023', 'INVALID_CURSOR', 'cross-board cursor rejected');
  return query select throws_ok('select hidden from public.game_players', '42501', null, 'moderation fields remain inaccessible');
  return query select throws_ok('select submission_key from public.game_best_scores', '42501', null, 'submission keys remain inaccessible');
  return query select throws_ok('select * from sg_private.game_submission_events', '42501', null, 'events remain inaccessible');
  return query select throws_ok('update public.game_best_scores set score = 0', '42501', null, 'read RPCs do not confer write access');
end $$;

set local role anon;
select * from pg_temp.public_reads();
reset role;
set local role authenticated;
select * from pg_temp.public_reads();
select throws_ok($$select public.sg_get_my_score('rank-asc')$$, '28000', 'UNAUTHORIZED', 'personal standing requires a subject');
set local request.jwt.claims = '{"sub":"bad-uuid"}';
select throws_ok($$select public.sg_get_my_score('rank-asc')$$, '28000', 'UNAUTHORIZED', 'malformed subject fails closed');
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000001","is_anonymous":true}';
select is(public.sg_get_my_score('rank-asc'), pg_temp.expected_entry(1,10,1,2), 'anonymous authenticated user has the same public tied rank');
select is(public.sg_get_my_score('rank-desc'), pg_temp.expected_entry(1,10,3,2), 'personal rank supports descending ties');
select throws_ok($$select public.sg_get_my_score('rank-asc', '50000000-0000-4000-8000-000000000004'::uuid)$$, '42883', null, 'cannot supply another player identity');
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000004","is_anonymous":false}';
select is(public.sg_get_my_score('rank-asc'), pg_temp.expected_entry(4,20,4,0), 'permanent account rank skips places after ties');
select is(public.sg_get_my_score('rank-desc'), pg_temp.expected_entry(4,20,2,0), 'permanent account descending rank matches page');
select throws_ok(format('select public.sg_get_my_score(%L)', board), 'P0002', 'LEADERBOARD_NOT_FOUND', 'personal standing also rejects missing/disabled board')
from (values ('missing'), ('rank-off')) as boards(board);
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000006"}';
select is(public.sg_get_my_score('rank-asc'), 'null'::jsonb, 'hidden owner has no visible standing');
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000007"}';
select is(public.sg_get_my_score('rank-asc'), 'null'::jsonb, 'player without score returns JSON null');
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000099"}';
select is(public.sg_get_my_score('rank-asc'), 'null'::jsonb, 'no visible score or profile returns null without creating a player');
reset role;
select is((select count(*) from public.game_players), 7::bigint, 'reads do not create profiles');

-- Strict decoded-cursor validation, including PostgreSQL casts that might round numbers.
create temporary table cursor_cases (value jsonb, label text);
insert into cursor_cases values ('null', 'JSON null'), ('[]', 'array'), ('1', 'number'), ('"token"', 'string'), ('{}', 'empty object');
insert into cursor_cases
select valid - field, 'missing ' || field from (select jsonb_build_object('boardId','rank-asc','score',10,
  'achievedAt','2026-01-01T00:00:01.123456Z','playerId','50000000-0000-4000-8000-000000000002') as valid) v
cross join (values ('boardId'), ('score'), ('achievedAt'), ('playerId')) as fields(field);
insert into cursor_cases
select valid || jsonb_build_object(field, value), label from (select jsonb_build_object('boardId','rank-asc','score',10,
  'achievedAt','2026-01-01T00:00:01.123456Z','playerId','50000000-0000-4000-8000-000000000002') as valid) v
cross join (values
  ('extra', 'true'::jsonb, 'unknown field'), ('boardId', 'null', 'null board'), ('boardId', '12', 'numeric board'),
  ('score', 'null', 'null score'), ('score', '"10"', 'string score'), ('score', '10.5', 'fractional score'),
  ('score', '9007199254740992', 'unsafe positive score'), ('score', '-9007199254740992', 'unsafe negative score'),
  ('playerId', 'null', 'null UUID'), ('playerId', '"invalid"', 'invalid UUID'), ('playerId', '1', 'numeric UUID'),
  ('achievedAt', 'null', 'null time'), ('achievedAt', '1', 'numeric time'), ('achievedAt', '"infinity"', 'infinite time'),
  ('achievedAt', '"yesterday"', 'relative time'), ('achievedAt', '"2026-01-01T00:00:00"', 'missing timezone'),
  ('achievedAt', '"2026-02-30T00:00:00Z"', 'impossible date'), ('achievedAt', '"2026-01-01T00:00:00.1234567Z"', 'precision loss')
) as fields(field, value, label);
grant select on cursor_cases to anon;
set local role anon;
select throws_ok(format('select public.sg_get_entries(''rank-asc'', 2, %L::jsonb)', value), '22023', 'INVALID_CURSOR', label || ' rejected') from cursor_cases;
-- An equivalent offset is the same instant, and an expired/deleted anchor need not exist.
select is(public.sg_get_entries('rank-asc', 2, '{"boardId":"rank-asc","score":10,"achievedAt":"2026-01-01T01:00:01.123456+01:00","playerId":"50000000-0000-4000-8000-000000000002"}') -> 'entries',
  jsonb_build_array(pg_temp.expected_entry(3,10,1,1), pg_temp.expected_entry(1,10,1,2)), 'timestamp offset preserves microsecond boundary and tied ranks');
select is(public.sg_get_entries('rank-asc', 2, '{"boardId":"rank-asc","score":30,"achievedAt":"2026-01-01T00:00:00.123456Z","playerId":"50000000-0000-4000-8000-000000000005"}'),
  '{"entries":[],"nextCursor":null}'::jsonb, 'cursor at final tuple returns empty final page');
reset role;

-- Submit through the actual Task 4 API; ranking reads must reflect best-only updates.
set local role authenticated;
set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000004"}';
select is(public.sg_submit_score('rank-asc', 5, gen_random_uuid())->>'outcome', 'best', 'integration: improving score accepted');
select is(public.sg_get_my_score('rank-asc')->>'rank', '1', 'integration: personal rank follows improvement');
select is(public.sg_submit_score('rank-asc', 50, gen_random_uuid())->>'outcome', 'not_best', 'integration: worse score ignored');
select is(public.sg_get_my_score('rank-asc')->>'score', '5', 'integration: ranking reads only the retained best');
select is(public.sg_get_entries('rank-asc')->'entries'->0, public.sg_get_my_score('rank-asc'), 'personal and public results agree after submission');
reset role;

-- Hostile caller paths and further RLS restrictions still apply to the invoker.
create temporary table game_best_scores (like public.game_best_scores including all);
grant select on pg_temp.game_best_scores to anon, authenticated;
set local search_path = pg_temp, public, extensions;
set local role anon;
select is(jsonb_array_length(public.sg_get_entries('rank-asc')->'entries'), 5, 'temporary objects cannot redirect table reads');
reset role;
create policy rankings_test_restriction on public.game_best_scores as restrictive for select to anon using (score >= 20);
set local role anon;
select is(public.sg_get_entries('rank-desc')->'entries', jsonb_build_array(pg_temp.expected_entry(5,30,1,0), pg_temp.expected_entry(4,20,2,0)), 'additional caller RLS is honored before ranking');
reset role;
drop policy rankings_test_restriction on public.game_best_scores;

-- More than the maximum page size: exercise defaults, upper bound and tie groups.
insert into auth.users (id) select ('51000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,105) n;
insert into public.game_players (user_id) select id from auth.users where id::text like '51000000-%';
insert into public.game_best_scores (leaderboard_id, user_id, score, achieved_at, submission_key)
select 'rank-empty', id, 7, '2026-01-01T00:00:00Z', gen_random_uuid() from auth.users where id::text like '51000000-%';
set local role anon;
select is(jsonb_array_length(public.sg_get_entries('rank-empty')->'entries'), 50, 'omitted limit defaults to 50');
select is(jsonb_array_length(public.sg_get_entries('rank-empty',100)->'entries'), 100, 'maximum page has 100 entries');
select is(jsonb_array_length(public.sg_get_entries('rank-empty',100,(public.sg_get_entries('rank-empty',100)->>'nextCursor')::jsonb)->'entries'), 5, 'final page contains the remaining tied players');
select is(public.sg_get_entries('rank-empty',100,(public.sg_get_entries('rank-empty',100)->>'nextCursor')::jsonb)->'entries'->0->>'rank', '1', 'rank stays one across a 100-player tied boundary');
reset role;
-- Continuation is a tuple boundary, not a lookup requiring the old anchor row.
create temporary table old_cursor as select (public.sg_get_entries('rank-desc',2)->>'nextCursor')::jsonb as value;
grant select on old_cursor to anon;
delete from public.game_best_scores where leaderboard_id = 'rank-desc' and user_id = '50000000-0000-4000-8000-000000000004';
set local role anon;
select is(public.sg_get_entries('rank-desc',2,(select value from old_cursor))->'entries',
  jsonb_build_array(pg_temp.expected_entry(2,10,2,1), pg_temp.expected_entry(3,10,2,1)), 'deleted cursor anchor still continues, using current visible ranks');
reset role;
select * from finish();
rollback;

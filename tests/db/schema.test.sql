-- Run only against the isolated local Supabase fixture. All test data rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select has_schema('sg_private', 'internal schema exists');
select has_table(s, t, s || '.' || t || ' exists')
from (values
  ('public', 'game_players'), ('public', 'game_leaderboards'),
  ('public', 'game_best_scores'), ('sg_private', 'game_submission_events')
) as tables(s, t);

select columns_are('public', 'game_players', array['user_id', 'display_name', 'hidden', 'created_at']);
select columns_are('public', 'game_leaderboards', array['id', 'kind', 'sort_direction', 'min_value', 'max_value', 'enabled']);
select columns_are('public', 'game_best_scores', array['leaderboard_id', 'user_id', 'score', 'achieved_at', 'submission_key']);
select columns_are('sg_private', 'game_submission_events', array['user_id', 'leaderboard_id', 'submission_key', 'submitted_score', 'outcome', 'created_at', 'best_score']);

select col_type_is(s, t, c, typ, t || '.' || c || ' has the intended type')
from (values
  ('public', 'game_players', 'user_id', 'uuid'),
  ('public', 'game_players', 'display_name', 'text'),
  ('public', 'game_players', 'hidden', 'boolean'),
  ('public', 'game_players', 'created_at', 'timestamp with time zone'),
  ('public', 'game_leaderboards', 'id', 'text'),
  ('public', 'game_leaderboards', 'kind', 'text'),
  ('public', 'game_leaderboards', 'sort_direction', 'text'),
  ('public', 'game_leaderboards', 'min_value', 'bigint'),
  ('public', 'game_leaderboards', 'max_value', 'bigint'),
  ('public', 'game_leaderboards', 'enabled', 'boolean'),
  ('public', 'game_best_scores', 'leaderboard_id', 'text'),
  ('public', 'game_best_scores', 'user_id', 'uuid'),
  ('public', 'game_best_scores', 'score', 'bigint'),
  ('public', 'game_best_scores', 'achieved_at', 'timestamp with time zone'),
  ('public', 'game_best_scores', 'submission_key', 'uuid'),
  ('sg_private', 'game_submission_events', 'user_id', 'uuid'),
  ('sg_private', 'game_submission_events', 'leaderboard_id', 'text'),
  ('sg_private', 'game_submission_events', 'submission_key', 'uuid'),
  ('sg_private', 'game_submission_events', 'submitted_score', 'bigint'),
  ('sg_private', 'game_submission_events', 'outcome', 'text'),
  ('sg_private', 'game_submission_events', 'created_at', 'timestamp with time zone')
) as columns(s, t, c, typ);

select col_not_null(s, t, c, t || '.' || c || ' is required')
from (values
  ('public', 'game_players', 'user_id'), ('public', 'game_players', 'hidden'),
  ('public', 'game_players', 'created_at'),
  ('public', 'game_leaderboards', 'id'), ('public', 'game_leaderboards', 'kind'),
  ('public', 'game_leaderboards', 'sort_direction'), ('public', 'game_leaderboards', 'enabled'),
  ('public', 'game_best_scores', 'leaderboard_id'), ('public', 'game_best_scores', 'user_id'),
  ('public', 'game_best_scores', 'score'), ('public', 'game_best_scores', 'achieved_at'),
  ('public', 'game_best_scores', 'submission_key'),
  ('sg_private', 'game_submission_events', 'user_id'), ('sg_private', 'game_submission_events', 'leaderboard_id'),
  ('sg_private', 'game_submission_events', 'submission_key'), ('sg_private', 'game_submission_events', 'submitted_score'),
  ('sg_private', 'game_submission_events', 'outcome'), ('sg_private', 'game_submission_events', 'created_at')
) as columns(s, t, c);
select col_is_null('public', 'game_players', 'display_name', 'unnamed profiles allow null');
select col_is_null('public', 'game_leaderboards', 'min_value', 'minimum bound may be absent');
select col_is_null('public', 'game_leaderboards', 'max_value', 'maximum bound may be absent');

select col_is_pk('public', 'game_players', array['user_id']);
select col_is_pk('public', 'game_leaderboards', array['id']);
select col_is_pk('public', 'game_best_scores', array['leaderboard_id', 'user_id']);
select col_is_pk('sg_private', 'game_submission_events', array['user_id', 'leaderboard_id', 'submission_key']);
select fk_ok('public', 'game_players', 'user_id', 'auth', 'users', 'id');
select fk_ok('public', 'game_best_scores', 'user_id', 'public', 'game_players', 'user_id');
select fk_ok('public', 'game_best_scores', 'leaderboard_id', 'public', 'game_leaderboards', 'id');
select fk_ok('sg_private', 'game_submission_events', 'user_id', 'public', 'game_players', 'user_id');
select fk_ok('sg_private', 'game_submission_events', 'leaderboard_id', 'public', 'game_leaderboards', 'id');

select is(
  (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'game_best_scores_rank_asc_idx'),
  'CREATE INDEX game_best_scores_rank_asc_idx ON public.game_best_scores USING btree (leaderboard_id, score, achieved_at, user_id)',
  'ascending index preserves achievement-time and player-ID tie ordering'
);
select is(
  (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'game_best_scores_rank_desc_idx'),
  'CREATE INDEX game_best_scores_rank_desc_idx ON public.game_best_scores USING btree (leaderboard_id, score DESC, achieved_at, user_id)',
  'descending index reverses scores without reversing tie ordering'
);
select is(
  (select indexdef from pg_indexes where schemaname = 'sg_private' and indexname = 'game_submission_events_rate_idx'),
  'CREATE INDEX game_submission_events_rate_idx ON sg_private.game_submission_events USING btree (user_id, leaderboard_id, created_at DESC)',
  'event index supports the planned per-player/board rate window'
);

select ok(
  (select relrowsecurity from pg_class where oid = to_regclass(s || '.' || t)),
  s || '.' || t || ' has RLS enabled'
)
from (values
  ('public', 'game_players'), ('public', 'game_leaderboards'),
  ('public', 'game_best_scores'), ('sg_private', 'game_submission_events')
) as tables(s, t);
select is((select count(*) from pg_policies where schemaname = 'sg_private'), 0::bigint,
  'no policies grant API access to internal data');
select is((select count(*) from pg_policies where schemaname = 'public'
  and tablename in ('game_players', 'game_leaderboards', 'game_best_scores') and cmd <> 'SELECT'),
  0::bigint, 'public tables have no client write policies');

-- Synthetic Auth users; no JWTs, passwords or hosted credentials.
insert into auth.users (id, is_anonymous) values
  ('10000000-0000-4000-8000-000000000001', true),
  ('10000000-0000-4000-8000-000000000002', false),
  ('10000000-0000-4000-8000-000000000003', true),
  ('10000000-0000-4000-8000-000000000004', true);
insert into public.game_players (user_id, display_name) values
  ('10000000-0000-4000-8000-000000000001', 'Visible One'),
  ('10000000-0000-4000-8000-000000000002', 'Visible Two'),
  ('10000000-0000-4000-8000-000000000003', 'Hidden Player');
update public.game_players set hidden = true where user_id = '10000000-0000-4000-8000-000000000003';
insert into public.game_leaderboards (id, kind, sort_direction, min_value, max_value) values
  ('time', 'time', 'asc', 0, 100000), ('points', 'points', 'desc', null, null),
  ('disabled', 'points', 'desc', null, null);
update public.game_leaderboards set enabled = false where id = 'disabled';
insert into public.game_best_scores (leaderboard_id, user_id, score, submission_key) values
  ('time', '10000000-0000-4000-8000-000000000001', 42, '20000000-0000-4000-8000-000000000001'),
  ('time', '10000000-0000-4000-8000-000000000002', 42, '20000000-0000-4000-8000-000000000002'),
  ('time', '10000000-0000-4000-8000-000000000003', 1, '20000000-0000-4000-8000-000000000003'),
  ('disabled', '10000000-0000-4000-8000-000000000001', 99, '20000000-0000-4000-8000-000000000004');
insert into sg_private.game_submission_events (user_id, leaderboard_id, submission_key, submitted_score, outcome, best_score) values
  ('10000000-0000-4000-8000-000000000001', 'time', '20000000-0000-4000-8000-000000000001', 42, 'best', 42);

select is((select hidden from public.game_players where display_name = 'Visible One'), false, 'players default to visible');
select is((select created_at from public.game_players where display_name = 'Visible One'), now(), 'profile time defaults to server transaction time');
select is((select enabled from public.game_leaderboards where id = 'time'), true, 'boards default to enabled');
select is((select achieved_at from public.game_best_scores where leaderboard_id = 'disabled'), now(), 'achievement time has a server default');
select is((select created_at from sg_private.game_submission_events), now(), 'event time has a server default');

-- Exercise constraints through actual writes, not only catalog inspection.
select throws_ok($$insert into public.game_players (user_id) values ('10000000-0000-4000-8000-000000000001')$$,
  '23505', null, 'duplicate player rejected');
select throws_ok($$insert into public.game_players (user_id) values ('10000000-0000-4000-8000-000000000099')$$,
  '23503', null, 'profile requires an Auth user');
select throws_ok($$insert into public.game_leaderboards (id, kind, sort_direction) values ('time', 'time', 'asc')$$,
  '23505', null, 'duplicate board rejected');
select throws_ok($$insert into public.game_best_scores (leaderboard_id, user_id, score, submission_key)
  select leaderboard_id, user_id, 20, '20000000-0000-4000-8000-000000000099' from public.game_best_scores limit 1$$,
  '23505', null, 'a second personal best for the same player and board is rejected');
select throws_ok($$insert into sg_private.game_submission_events select * from sg_private.game_submission_events$$,
  '23505', null, 'duplicate player/board/submission key rejected');
select lives_ok($$insert into sg_private.game_submission_events (user_id, leaderboard_id, submission_key, submitted_score, outcome, best_score) values
  ('10000000-0000-4000-8000-000000000002', 'time', '20000000-0000-4000-8000-000000000001', 100, 'not_best', 42),
  ('10000000-0000-4000-8000-000000000001', 'points', '20000000-0000-4000-8000-000000000001', 100, 'best', 100)$$,
  'the same key is valid for a different player or board');

select throws_ok(format('update %s set %I = %L where user_id = %L and leaderboard_id = %L', t, c, v, '10000000-0000-4000-8000-000000000001', 'time'), '23503', null, t || '.' || c || ' enforces its foreign key')
from (values
  ('public.game_best_scores', 'user_id', '10000000-0000-4000-8000-000000000004'),
  ('public.game_best_scores', 'leaderboard_id', 'missing'),
  ('sg_private.game_submission_events', 'user_id', '10000000-0000-4000-8000-000000000004'),
  ('sg_private.game_submission_events', 'leaderboard_id', 'missing')
) as cases(t, c, v);

select throws_ok(format('update public.game_leaderboards set %I = %L where id = %L', c, v, 'time'),
  '23514', null, 'reject invalid board ' || c || ': ' || v)
from (values
  ('id', ''), ('kind', 'unknown'), ('sort_direction', 'sideways'),
  ('min_value', '100001'), ('min_value', '-9007199254740992'), ('max_value', '9007199254740992')
) as cases(c, v);
select throws_ok($$update sg_private.game_submission_events set outcome = 'unknown'$$,
  '23514', null, 'event outcomes are constrained');
select throws_ok(format('update %s set %I = %s', t, c, v), '23514', null, t || '.' || c || ' rejects unsafe integer ' || v)
from (values ('public.game_best_scores', 'score'), ('sg_private.game_submission_events', 'submitted_score')) as cols(t, c)
cross join (values ('9007199254740992'), ('-9007199254740992')) as bounds(v);
select lives_ok($$insert into public.game_best_scores (leaderboard_id, user_id, score, submission_key) values
  ('points', '10000000-0000-4000-8000-000000000001', -9007199254740991, '20000000-0000-4000-8000-000000000005'),
  ('points', '10000000-0000-4000-8000-000000000002', 9007199254740991, '20000000-0000-4000-8000-000000000006')$$,
  'both JSON-safe integer boundaries fit in BIGINT');

-- Test-only, SECURITY INVOKER helper runs the same real queries as each API role.
-- Inspect private object ACLs as the owner: API roles cannot even resolve the
-- schema-qualified table name. The helper below also tests actual access denial.
select ok(not has_table_privilege(r, t, p), r || ' has no ' || p || ' grant on ' || t)
from (values ('anon'), ('authenticated')) as roles(r)
cross join (values ('public.game_players'), ('public.game_leaderboards'), ('public.game_best_scores'), ('sg_private.game_submission_events')) as tables(t)
cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as privileges(p);
select ok(not has_any_column_privilege(r, t, p), r || ' has no column ' || p || ' grant on ' || t)
from (values ('anon'), ('authenticated')) as roles(r)
cross join (values ('public.game_players'), ('public.game_leaderboards'), ('public.game_best_scores'), ('sg_private.game_submission_events')) as tables(t)
cross join (values ('INSERT'), ('UPDATE'), ('REFERENCES')) as privileges(p);
select ok(not has_table_privilege(r, 'sg_private.game_submission_events', 'SELECT'), r || ' has no event SELECT grant')
from (values ('anon'), ('authenticated')) as roles(r);

create function pg_temp.assert_api_permissions() returns setof text language plpgsql as $body$
declare
  -- current_user is NAME (C collation); a TEXT label avoids conflicting with
  -- the database collation when pgTAP compares text rows to expected arrays.
  role_label text collate "default" := current_user;
begin
  return query select results_eq('select display_name from public.game_players order by display_name',
    array['Visible One', 'Visible Two']::text[], role_label || ' sees visible profiles only');
  return query select results_eq('select id from public.game_leaderboards order by id',
    array['points', 'time']::text[], role_label || ' sees enabled boards only');
  return query select results_eq($$select score from public.game_best_scores where leaderboard_id = 'time' order by user_id$$,
    array[42, 42]::bigint[], role_label || ' cannot read a hidden player score');
  return query select is_empty($$select score from public.game_best_scores where leaderboard_id = 'disabled'$$,
    role_label || ' cannot read disabled board scores');
  return query select throws_ok('select submission_key from public.game_best_scores', '42501', null,
    role_label || ' cannot read other players submission keys');
  return query select throws_ok('select hidden from public.game_players', '42501', null,
    role_label || ' cannot read moderation flags');
  return query select throws_ok('select * from sg_private.game_submission_events', '42501', null,
    role_label || ' cannot read submission events');
  return query select ok(not has_schema_privilege(current_user, 'sg_private', 'USAGE'), role_label || ' has no private schema usage');
  return query select ok(not has_schema_privilege(current_user, 'sg_private', 'CREATE'), role_label || ' cannot create private objects');
  return query select throws_ok(statement, '42501', null, role_label || ' cannot directly ' || label)
  from (values
    ('insert into public.game_players (user_id) values (''10000000-0000-4000-8000-000000000004'')', 'insert a player'),
    ('update public.game_players set display_name = ''Forged''', 'update a player'),
    ('delete from public.game_players', 'delete a player'),
    ('insert into public.game_leaderboards (id, kind, sort_direction) values (''forged'', ''points'', ''desc'')', 'insert a board'),
    ('update public.game_leaderboards set enabled = false', 'update a board'),
    ('delete from public.game_leaderboards', 'delete a board'),
    ('insert into public.game_best_scores (leaderboard_id, user_id, score, submission_key) values (''points'', ''10000000-0000-4000-8000-000000000003'', 1, ''20000000-0000-4000-8000-000000000099'')', 'insert a score'),
    ('update public.game_best_scores set score = 1', 'update a score'),
    ('delete from public.game_best_scores', 'delete a score'),
    ('insert into sg_private.game_submission_events (user_id, leaderboard_id, submission_key, submitted_score, outcome, best_score) values (''10000000-0000-4000-8000-000000000003'', ''time'', ''20000000-0000-4000-8000-000000000099'', 1, ''best'', 1)', 'insert an event'),
    ('update sg_private.game_submission_events set submitted_score = 1', 'update an event'),
    ('delete from sg_private.game_submission_events', 'delete an event')
  ) as attempts(statement, label);
end;
$body$;

set local role anon;
select * from pg_temp.assert_api_permissions();
reset role;
-- Supabase anonymous Auth users have the authenticated database role too.
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}';
set local role authenticated;
select * from pg_temp.assert_api_permissions();
reset role;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}';
set local role authenticated;
select * from pg_temp.assert_api_permissions();
reset role;

-- RLS still filters rows if a future grant accidentally becomes broader.
grant select on public.game_players, public.game_leaderboards, public.game_best_scores to anon;
set local role anon;
select results_eq('select display_name from public.game_players order by display_name',
  array['Visible One', 'Visible Two']::text[], 'RLS filters profiles independently of column grants');
select is_empty($$select * from public.game_leaderboards where id = 'disabled'$$, 'RLS filters disabled boards');
select is_empty($$select * from public.game_best_scores where user_id = '10000000-0000-4000-8000-000000000003'$$, 'RLS filters hidden scores');
reset role;

-- A private-schema exposure misconfiguration alone must not reveal events.
grant usage on schema sg_private to anon;
set local role anon;
select throws_ok('select * from sg_private.game_submission_events', '42501', null, 'event table grants remain closed even with schema usage');
reset role;
grant select on sg_private.game_submission_events to anon;
set local role anon;
select is_empty('select * from sg_private.game_submission_events', 'private table RLS denies rows even after accidental SELECT grant');
reset role;

-- Trusted account/board deletion must not leave orphaned scores or events.
delete from auth.users where id = '10000000-0000-4000-8000-000000000001';
select is_empty($$select * from public.game_players where user_id = '10000000-0000-4000-8000-000000000001'$$, 'Auth deletion cascades to profile');
select is_empty($$select * from public.game_best_scores where user_id = '10000000-0000-4000-8000-000000000001'$$, 'Auth deletion cascades to scores');
select is_empty($$select * from sg_private.game_submission_events where user_id = '10000000-0000-4000-8000-000000000001'$$, 'Auth deletion cascades to events');
delete from public.game_leaderboards where id = 'time';
select is_empty($$select * from public.game_best_scores where leaderboard_id = 'time'$$, 'board deletion cascades to scores');
select is_empty($$select * from sg_private.game_submission_events where leaderboard_id = 'time'$$, 'board deletion cascades to events');

select * from finish();
rollback;

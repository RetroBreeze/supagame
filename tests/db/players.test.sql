-- Local Supabase only. All users, profiles, helpers and grants roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select has_function('public', 'sg_get_my_profile', array[]::text[], 'profile getter exists');
select has_function('public', 'sg_update_my_profile', array['text'], 'profile updater exists');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('sg_get_my_profile', 'sg_update_my_profile')),
  2::bigint, 'there are no alternative signatures accepting a target player');

select ok((select prosecdef from pg_proc where oid = to_regprocedure(signature)), signature || ' uses SECURITY DEFINER')
from (values ('public.sg_get_my_profile()'), ('public.sg_update_my_profile(text)')) as funcs(signature);
select is((select prorettype from pg_proc where oid = to_regprocedure(signature)), 'jsonb'::regtype::oid, signature || ' returns JSONB')
from (values ('public.sg_get_my_profile()'), ('public.sg_update_my_profile(text)')) as funcs(signature);
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = to_regprocedure(signature)),
  signature || ' pins an empty search_path')
from (values ('public.sg_get_my_profile()'), ('public.sg_update_my_profile(text)')) as funcs(signature);
select ok(has_function_privilege('authenticated', signature, 'EXECUTE'), 'authenticated may execute ' || signature)
from (values ('public.sg_get_my_profile()'), ('public.sg_update_my_profile(text)')) as funcs(signature);
select ok(not has_function_privilege(r, signature, 'EXECUTE'), r || ' cannot execute ' || signature)
from (values ('anon'), ('service_role')) as roles(r)
cross join (values ('public.sg_get_my_profile()'), ('public.sg_update_my_profile(text)')) as funcs(signature);
select is((select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a
  where p.oid in (to_regprocedure('public.sg_get_my_profile()'), to_regprocedure('public.sg_update_my_profile(text)'))
  and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 0::bigint, 'PUBLIC has no execute grant');

insert into auth.users (id, is_anonymous) values
  ('30000000-0000-4000-8000-000000000001', true),
  ('30000000-0000-4000-8000-000000000002', false),
  ('30000000-0000-4000-8000-000000000003', true),
  ('30000000-0000-4000-8000-000000000004', true);

set local role anon;
select throws_ok('select public.sg_get_my_profile()', '42501', null, 'unauthenticated role cannot get a profile');
select throws_ok($$select public.sg_update_my_profile('Guest')$$, '42501', null, 'unauthenticated role cannot update');
reset role;

-- Check authentication inside the functions, independently of EXECUTE grants.
set local role authenticated;
select throws_ok('select public.sg_get_my_profile()', '28000', 'UNAUTHORIZED', 'authenticated role without a subject is denied');
select throws_ok($$select public.sg_update_my_profile('Guest')$$, '28000', 'UNAUTHORIZED', 'updater requires a subject too');
reset role;
set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000099","role":"authenticated"}';
set local role authenticated;
select throws_ok('select public.sg_get_my_profile()', '28000', 'UNAUTHORIZED', 'missing/deleted Auth user is denied without SQL details');
select throws_ok($$select public.sg_update_my_profile('Ghost')$$, '28000', 'UNAUTHORIZED', 'updater rejects a missing Auth user');
reset role;
set local request.jwt.claims = '{"sub":"invalid-uuid","role":"authenticated"}';
set local role authenticated;
select throws_ok('select public.sg_get_my_profile()', '28000', 'UNAUTHORIZED', 'malformed subject fails closed');
select throws_ok($$select public.sg_update_my_profile('Ghost')$$, '28000', 'UNAUTHORIZED', 'updater rejects malformed subject');
reset role;
select is((select count(*) from public.game_players), 0::bigint, 'denied requests created no profiles');

set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}';
set local role authenticated;
select is(public.sg_get_my_profile(), jsonb_build_object(
  'playerId', '30000000-0000-4000-8000-000000000001', 'displayName', null, 'createdAt', now()),
  'first anonymous request creates and returns exactly the public DTO');
select is(public.sg_get_my_profile(), jsonb_build_object(
  'playerId', '30000000-0000-4000-8000-000000000001', 'displayName', null, 'createdAt', now()),
  'repeated retrieval returns the same profile');
select is(public.sg_update_my_profile(E' \t\nAnon Player\r ') ->> 'displayName', 'Anon Player',
  'surrounding whitespace is trimmed before validation');
select is(public.sg_get_my_profile() ->> 'displayName', 'Anon Player', 'retrieval does not reset a name');
reset role;
select is((select count(*) from public.game_players), 1::bigint, 'repeat calls do not duplicate the profile');

-- PATCH can be the first call; existing permanent Auth users are supported.
set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}';
set local role authenticated;
select is(public.sg_update_my_profile('Permanent Player'), jsonb_build_object(
  'playerId', '30000000-0000-4000-8000-000000000002', 'displayName', 'Permanent Player', 'createdAt', now()),
  'first update creates the permanent user profile with only public fields');
select throws_ok($$select public.sg_update_my_profile(p_display_name => 'Forged', p_user_id => '30000000-0000-4000-8000-000000000001'::uuid)$$,
  '42883', null, 'the RPC has no cross-user update parameter');
select throws_ok($$select public.sg_get_my_profile('30000000-0000-4000-8000-000000000001'::uuid)$$,
  '42883', null, 'the RPC has no cross-user read parameter');
select throws_ok($$update public.game_players set display_name = 'Forged' where user_id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'direct cross-user writes remain forbidden');
select throws_ok($$update public.game_players set hidden = false$$, '42501', null, 'moderation fields cannot be changed directly');
select throws_ok($$update public.game_players set created_at = now()$$, '42501', null, 'creation timestamps cannot be changed directly');
select throws_ok($$insert into public.game_players (user_id) values ('30000000-0000-4000-8000-000000000003')$$,
  '42501', null, 'direct profile creation remains forbidden');
select throws_ok('delete from public.game_players', '42501', null, 'direct profile deletion remains forbidden');
reset role;
select is((select display_name from public.game_players where user_id = '30000000-0000-4000-8000-000000000001'),
  'Anon Player', 'other player profile was not modified');

-- Valid Unicode names count characters, not UTF-8 bytes; quotes are data.
set local role authenticated;
select is(public.sg_update_my_profile(input) ->> 'displayName', expected, label)
from (values
  ('abc', 'abc', 'minimum length'),
  (repeat('a', 24), repeat('a', 24), 'maximum length'),
  ('  ' || repeat('a', 24) || '  ', repeat('a', 24), 'length is checked after trimming'),
  (U&'\00A0\3000Player\00A0\3000', 'Player', 'Unicode surrounding whitespace'),
  ('猫咪王', '猫咪王', 'non-ASCII printable characters'),
  ('O''Brien', 'O''Brien', 'apostrophes are not SQL'),
  ('x'';--', 'x'';--', 'SQL-looking text is not executed')
) as names(input, expected, label);
select throws_ok(format('select public.sg_update_my_profile(%L)', input), '22023', 'INVALID_DISPLAY_NAME', label)
from (values
  (null::text, 'null name'), ('', 'empty name'), ('ab', 'too short'),
  ('   ', 'whitespace-only'), (E'\t\n\r', 'control whitespace-only'),
  ('  ab  ', 'too short after trimming'), (repeat('a', 25), 'too long'),
  (E'bad\nname', 'embedded newline'), (E'bad\tname', 'embedded tab'),
  ('bad' || chr(1) || 'name', 'C0 control character'),
  ('bad' || chr(127) || 'name', 'DEL character'),
  ('bad' || chr(133) || 'name', 'C1 control character')
) as names(input, label);
reset role;
select is((select display_name from public.game_players where user_id = '30000000-0000-4000-8000-000000000002'),
  'x'';--', 'invalid updates leave the previous name unchanged');
select is((select created_at from public.game_players where user_id = '30000000-0000-4000-8000-000000000002'),
  now(), 'updates preserve creation time');

set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.sg_update_my_profile('ab')$$, '22023', 'INVALID_DISPLAY_NAME', 'invalid first update is rejected');
reset role;
select is_empty($$select user_id from public.game_players where user_id = '30000000-0000-4000-8000-000000000003'$$,
  'invalid first update does not create a profile');

-- Hidden means excluded from public listings, not that the owner can unhide it.
update public.game_players set hidden = true where user_id = '30000000-0000-4000-8000-000000000001';
set local role anon;
select is_empty($$select user_id from public.game_players where user_id = '30000000-0000-4000-8000-000000000001'$$, 'guest listings exclude hidden profiles');
reset role;
set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}';
set local role authenticated;
select is_empty($$select user_id from public.game_players where user_id = '30000000-0000-4000-8000-000000000001'$$, 'authenticated listings also exclude hidden profiles');
select is(public.sg_get_my_profile() ->> 'playerId', '30000000-0000-4000-8000-000000000001', 'hidden owner can retrieve their own profile');
select is(public.sg_update_my_profile('Still Hidden'), jsonb_build_object(
  'playerId', '30000000-0000-4000-8000-000000000001', 'displayName', 'Still Hidden', 'createdAt', now()),
  'hidden owner can rename without seeing moderation fields');
reset role;
select is((select hidden from public.game_players where user_id = '30000000-0000-4000-8000-000000000001'), true, 'renaming does not unhide a profile');

-- Caller-controlled search paths and temporary objects cannot redirect writes.
create temporary table game_players (like public.game_players including all);
grant all on pg_temp.game_players to authenticated;
create function pg_temp.btrim(text, text) returns text language sql as $$select 'Hijacked'::text$$;
set local search_path = pg_temp, public, auth, extensions;
set local request.jwt.claims = '{"sub":"30000000-0000-4000-8000-000000000004","role":"authenticated"}';
set local role authenticated;
select is(public.sg_get_my_profile() ->> 'playerId', '30000000-0000-4000-8000-000000000004', 'getter ignores caller-controlled table lookup');
select is(public.sg_update_my_profile(' Safe Name ') ->> 'displayName', 'Safe Name', 'updater ignores caller-controlled function lookup');
reset role;
select is_empty('select * from pg_temp.game_players', 'temporary table did not receive profile writes');
select is((select display_name from public.game_players where user_id = '30000000-0000-4000-8000-000000000004'), 'Safe Name', 'the real caller profile was updated');

select * from finish();
rollback;

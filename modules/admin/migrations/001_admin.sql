-- Optional Admin. The best-score table remains an active-generation projection.
alter table public.game_leaderboards add column generation bigint not null default 1,
 add column admin_revision bigint not null default 0;
alter table sg_private.game_submission_events
 add column id uuid not null default gen_random_uuid() unique,
 add column generation bigint not null default 1,
 add column hidden boolean not null default false,
 add column moderation_reason text,
 add column admin_revision bigint not null default 0;
create index admin_history on sg_private.game_submission_events(leaderboard_id,generation,user_id);
-- Preserve trusted seeded bests that predate submission recording.
insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,created_at,best_score)
 select user_id,leaderboard_id,submission_key,score,'best',achieved_at,score from public.game_best_scores
 on conflict(user_id,leaderboard_id,submission_key) do nothing;
create table sg_private.admin_permissions (
 user_id uuid references auth.users(id) on delete cascade,
 permission text check(permission in ('leaderboards.read','leaderboards.manage','scores.moderate','players.restrict','admins.manage','audit.read')),
 primary key(user_id,permission)
);
create table sg_private.admin_restrictions (
 user_id uuid primary key references auth.users(id) on delete cascade,
 restricted boolean not null default false,
 reason text not null,
 revision bigint not null default 0
);
create table sg_private.admin_audit (
 operation_id uuid primary key,
 actor text not null,
 action text not null,
 target text not null,
 target_type text not null,
 created_at timestamptz not null default clock_timestamp(),
 reason text not null,
 outcome text not null default 'applied',
 before_state jsonb not null,
 after_state jsonb not null,
 request jsonb not null
);
alter table sg_private.admin_permissions enable row level security;
alter table sg_private.admin_restrictions enable row level security;
alter table sg_private.admin_audit enable row level security;
revoke all on sg_private.admin_permissions, sg_private.admin_restrictions, sg_private.admin_audit from public,anon,authenticated,service_role;

-- Future server endpoints may use this check, but receive no execution grant now.
create function sg_private.admin_has_permission(p_user uuid,p_permission text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u join sg_private.admin_permissions p on p.user_id=u.id
 where u.id=p_user and not u.is_anonymous and p.permission=p_permission)
$$;
revoke all on function sg_private.admin_has_permission(uuid,text) from public,anon,authenticated,service_role;

create function sg_private.admin_project_score(p_board text,p_user uuid) returns void
language plpgsql set search_path='' as $$
begin
 delete from public.game_best_scores where leaderboard_id=p_board and user_id=p_user;
 insert into public.game_best_scores(leaderboard_id,user_id,score,achieved_at,submission_key)
 select e.leaderboard_id,e.user_id,e.submitted_score,e.created_at,e.submission_key
 from sg_private.game_submission_events e join public.game_leaderboards b on b.id=e.leaderboard_id
 where e.leaderboard_id=p_board and e.user_id=p_user and e.generation=b.generation and not e.hidden
 order by case when b.sort_direction='asc' then e.submitted_score end asc,
 case when b.sort_direction='desc' then e.submitted_score end desc,e.created_at,e.id limit 1;
end $$;
revoke all on function sg_private.admin_project_score(text,uuid) from public,anon,authenticated,service_role;

create function sg_private.admin_apply(p_action text,p_target text,p_revision bigint,p_operation uuid,p_reason text) returns jsonb
language plpgsql set search_path='' as $$
declare v_before jsonb; v_after jsonb; v_board text; v_user uuid; v_revision bigint; v_request jsonb; v_old sg_private.admin_audit%rowtype;
begin
 if current_user not in ('postgres','supabase_admin') then raise exception 'ADMIN_DENIED'; end if;
 if current_setting('transaction_isolation') <> 'read committed' then raise exception 'READ_COMMITTED_REQUIRED'; end if;
 if p_operation is null or p_reason is null or length(trim(p_reason)) not between 1 and 1000 then raise exception 'ADMIN_REASON_REQUIRED'; end if;
 if p_action not in ('leaderboard.reset','leaderboard.disable','leaderboard.enable','score.hide','score.restore','player.restrict','player.reinstate') then raise exception 'ADMIN_INVALID_ACTION'; end if;
 v_request := jsonb_build_object('action',p_action,'target',p_target,'revision',p_revision,'reason',p_reason);
 perform pg_advisory_xact_lock(hashtextextended('supagame:admin:'||p_operation,0));
 select * into v_old from sg_private.admin_audit where operation_id=p_operation;
 if found then
  if v_old.request <> v_request then raise exception 'ADMIN_OPERATION_CONFLICT'; end if;
  return v_old.after_state;
 end if;
 if p_action like 'leaderboard.%' then
  select to_jsonb(b),b.admin_revision into v_before,v_revision from public.game_leaderboards b where id=p_target for update;
  v_board:=p_target;
 elsif p_action like 'score.%' then
  select leaderboard_id,user_id into v_board,v_user from sg_private.game_submission_events where id=p_target::uuid;
  perform 1 from public.game_leaderboards where id=v_board for update;
  select to_jsonb(e),e.admin_revision into v_before,v_revision from sg_private.game_submission_events e where id=p_target::uuid for update;
 else
  v_user:=p_target::uuid;
  perform pg_advisory_xact_lock(hashtextextended('supagame:restriction:'||v_user,0));
  if not exists(select 1 from auth.users where id=v_user) then raise exception 'ADMIN_TARGET_NOT_FOUND'; end if;
  select to_jsonb(r),r.revision into v_before,v_revision from sg_private.admin_restrictions r where user_id=v_user;
  if not found then v_before:=jsonb_build_object('user_id',v_user,'restricted',false,'revision',0); v_revision:=0; end if;
 end if;
 if v_before is null then raise exception 'ADMIN_TARGET_NOT_FOUND'; end if;
 if p_revision is distinct from v_revision then raise exception 'ADMIN_STALE_STATE'; end if;
 if p_action='leaderboard.reset' then
  update public.game_leaderboards set generation=generation+1,admin_revision=admin_revision+1 where id=v_board;
  delete from public.game_best_scores where leaderboard_id=v_board;
 elsif p_action like 'leaderboard.%' then
  update public.game_leaderboards set enabled=(p_action='leaderboard.enable'),admin_revision=admin_revision+1 where id=v_board;
 elsif p_action like 'score.%' then
  update sg_private.game_submission_events set hidden=(p_action='score.hide'),moderation_reason=p_reason,admin_revision=admin_revision+1 where id=p_target::uuid;
  perform sg_private.admin_project_score(v_board,v_user);
 else
  insert into sg_private.admin_restrictions(user_id,restricted,reason,revision) values(v_user,p_action='player.restrict',p_reason,1)
  on conflict(user_id) do update set restricted=excluded.restricted,reason=excluded.reason,revision=admin_restrictions.revision+1;
 end if;
 if p_action like 'leaderboard.%' then select to_jsonb(b) into v_after from public.game_leaderboards b where id=v_board;
 elsif p_action like 'score.%' then select to_jsonb(e) into v_after from sg_private.game_submission_events e where id=p_target::uuid;
 else select to_jsonb(r) into v_after from sg_private.admin_restrictions r where user_id=v_user; end if;
 if v_board is not null and exists(select 1 from pg_trigger where tgname='supagame_live_scores' and not tgisinternal) then
  perform realtime.send(jsonb_build_object('boardId',v_board),'changed','supagame:leaderboard:'||v_board,true);
 end if;
 insert into sg_private.admin_audit(operation_id,actor,action,target,target_type,reason,before_state,after_state,request)
 values(p_operation,session_user,p_action,p_target,split_part(p_action,'.',1),p_reason,v_before,v_after,v_request);
 return v_after;
end $$;
revoke all on function sg_private.admin_apply(text,text,bigint,uuid,text) from public,anon,authenticated,service_role;

-- Readability is independent of submission eligibility when Admin is installed.
alter policy game_leaderboards_enabled_read on public.game_leaderboards using (true);

create or replace function public.sg_submit_score(
  p_board_id text,
  p_score bigint,
  p_submission_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_board public.game_leaderboards%rowtype;
  v_event sg_private.game_submission_events%rowtype;
  v_now timestamptz;
  v_best_score bigint;
  v_outcome text;
begin
  begin
    v_user_id := auth.uid();
  exception when invalid_text_representation then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end;
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end if;
  -- Pin the Auth identity for this transaction, including replay-only requests.
  perform 1 from auth.users where id = v_user_id for key share;
  if not found then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end if;
  -- A transaction-wide snapshot could miss events committed while waiting for
  -- the advisory lock. Reject it rather than allow a stale quota/replay check.
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
    raise exception using errcode = '0A000', message = 'READ_COMMITTED_REQUIRED';
  end if;
  if p_board_id is null or p_board_id = '' or p_submission_key is null then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST';
  end if;
  if p_score is null or p_score not between -9007199254740991 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_SCORE';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:restriction:' || v_user_id,0));
  if exists(select 1 from sg_private.admin_restrictions where user_id=v_user_id and restricted) then
    raise exception using errcode='42501', message='PLAYER_RESTRICTED';
  end if;

  -- Transaction-scoped, namespaced per-player/board serialization covers event
  -- lookup, quota and writes. Hash collisions only serialize unrelated pairs.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'supagame:submission:' || v_user_id::text || ':' || p_board_id, 0));

  select * into v_event from sg_private.game_submission_events
    where user_id = v_user_id and leaderboard_id = p_board_id and submission_key = p_submission_key;
  if found then
    if v_event.submitted_score <> p_score then
      raise exception using errcode = '23505', message = 'DUPLICATE_KEY_CONFLICT';
    end if;
    -- Replays do not revalidate mutable board configuration or spend quota.
    return pg_catalog.jsonb_build_object(
      'outcome', v_event.outcome, 'score', v_event.submitted_score, 'bestScore', v_event.best_score);
  end if;

  -- Prevent trusted configuration updates/deletion during a new submission.
  select * into v_board from public.game_leaderboards where id = p_board_id for share;
  if not found or not v_board.enabled then
    raise exception using errcode = 'P0002', message = 'LEADERBOARD_NOT_FOUND';
  end if;
  if p_score < v_board.min_value or p_score > v_board.max_value then
    raise exception using errcode = '22023', message = 'INVALID_SCORE';
  end if;

  -- Use processing time after waiting, never transaction-start now().
  v_now := pg_catalog.clock_timestamp();
  if (select count(*) from sg_private.game_submission_events
    where user_id = v_user_id and leaderboard_id = p_board_id
      and created_at > v_now - interval '60 seconds') >= 10 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  insert into public.game_players (user_id) values (v_user_id)
    on conflict (user_id) do nothing;
  insert into public.game_best_scores as best (leaderboard_id, user_id, score, achieved_at, submission_key)
    values (p_board_id, v_user_id, p_score, v_now, p_submission_key)
    on conflict (leaderboard_id, user_id) do update
      set score = excluded.score, achieved_at = excluded.achieved_at, submission_key = excluded.submission_key
      where (v_board.sort_direction = 'asc' and excluded.score < best.score)
        or (v_board.sort_direction = 'desc' and excluded.score > best.score)
    returning score into v_best_score;
  if found then
    v_outcome := 'best';
  else
    v_outcome := 'not_best';
    select score into v_best_score from public.game_best_scores
      where leaderboard_id = p_board_id and user_id = v_user_id;
  end if;

  insert into sg_private.game_submission_events
    (user_id, leaderboard_id, submission_key, submitted_score, outcome, created_at, best_score, generation)
    values (v_user_id, p_board_id, p_submission_key, p_score, v_outcome, v_now, v_best_score, v_board.generation);
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'score', p_score, 'bestScore', v_best_score);
end;
$function$;

revoke all on function public.sg_submit_score(text, bigint, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.sg_submit_score(text, bigint, uuid) to authenticated;

-- Additive read APIs. No table grants or policies change; every read uses RLS.
create or replace function public.sg_list_leaderboards()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', board.id, 'kind', board.kind, 'sortDirection', board.sort_direction,
    'minValue', board.min_value, 'maxValue', board.max_value
  ) order by board.id), '[]'::jsonb)
  from public.game_leaderboards as board;
$function$;

create or replace function public.sg_get_entries(
  p_board_id text,
  p_limit integer default 50,
  p_cursor jsonb default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_direction text;
  v_generation bigint;
  v_score bigint;
  v_numeric_score numeric;
  v_time timestamptz;
  v_player uuid;
  v_order text;
  v_continuation text := 'true';
  v_result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST';
  end if;
  select board.sort_direction,board.generation into v_direction,v_generation from public.game_leaderboards as board
    where board.id = p_board_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEADERBOARD_NOT_FOUND';
  end if;

  if p_cursor is not null then
    if pg_catalog.octet_length(p_cursor::text) > 4096
      or pg_catalog.jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CURSOR';
    end if;
    if (select count(*) from pg_catalog.jsonb_object_keys(p_cursor)) <> 5
      or p_cursor->>'generation' is distinct from v_generation::text
      or pg_catalog.jsonb_typeof(p_cursor->'boardId') is distinct from 'string'
      or p_cursor->>'boardId' is distinct from p_board_id
      or pg_catalog.jsonb_typeof(p_cursor->'score') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_cursor->'achievedAt') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_cursor->'playerId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'INVALID_CURSOR';
    end if;
    begin
      v_numeric_score := (p_cursor->>'score')::numeric;
      if v_numeric_score <> pg_catalog.trunc(v_numeric_score)
        or v_numeric_score not between -9007199254740991 and 9007199254740991
        or (p_cursor->>'achievedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
        or (p_cursor->>'playerId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception using errcode = '22023', message = 'INVALID_CURSOR';
      end if;
      v_score := v_numeric_score::bigint;
      v_time := (p_cursor->>'achievedAt')::timestamptz;
      v_player := (p_cursor->>'playerId')::uuid;
    exception
      when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023', message = 'INVALID_CURSOR';
    end;
  end if;

  -- Only fixed SQL fragments enter format(); all caller values are parameters.
  -- Separate ASC/DESC plans can use the corresponding ordered ranking index.
  if v_direction = 'asc' then
    v_order := 'score asc, achieved_at asc, user_id asc';
    if p_cursor is not null then
      v_continuation := '(score, achieved_at, user_id) > ($2, $3, $4)';
    end if;
  else
    v_order := 'score desc, achieved_at asc, user_id asc';
    if p_cursor is not null then
      v_continuation := '(score < $2 or (score = $2 and (achieved_at, user_id) > ($3, $4)))';
    end if;
  end if;

  -- Rank the visible board BEFORE cursor filtering: filtering first would reset
  -- ranks on every page and break ties spanning a boundary. Limit + 1 establishes
  -- whether a next page exists, without an unbounded JSON aggregation.
  execute pg_catalog.format($query$
    with ranked as (
      select best.user_id, player.display_name, best.score, best.achieved_at,
        pg_catalog.rank() over (order by best.score %s) as competition_rank
      from public.game_best_scores as best
      join public.game_players as player on player.user_id = best.user_id
      where best.leaderboard_id = $1
    ), page as materialized (
      select * from ranked where %s order by %s limit ($5 + 1)
    ), numbered as (
      select *, pg_catalog.row_number() over (order by %s) as position from page
    )
    select pg_catalog.jsonb_build_object(
      'entries', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'playerId', user_id, 'displayName', display_name, 'score', score,
        'rank', competition_rank, 'achievedAt', achieved_at
      ) order by position) filter (where position <= $5), '[]'::jsonb),
      'nextCursor', case when count(*) > $5 then (
        select pg_catalog.jsonb_build_object('generation', $6, 'boardId', $1, 'score', score,
          'achievedAt', achieved_at, 'playerId', user_id)::text
        from numbered where position = $5
      ) else null end
    ) from numbered
  $query$, case when v_direction = 'asc' then 'asc' else 'desc' end,
    v_continuation, v_order, v_order)
    into v_result using p_board_id, v_score, v_time, v_player, p_limit, v_generation;
  return v_result;
end;
$function$;

create or replace function public.sg_get_my_score(p_board_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_direction text;
  v_mine record;
  v_rank bigint;
begin
  begin
    v_user_id := auth.uid();
  exception when invalid_text_representation then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end;
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end if;
  select board.sort_direction into v_direction from public.game_leaderboards as board
    where board.id = p_board_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEADERBOARD_NOT_FOUND';
  end if;
  select best.score, best.achieved_at, player.display_name into v_mine
    from public.game_best_scores as best
    join public.game_players as player on player.user_id = best.user_id
    where best.leaderboard_id = p_board_id and best.user_id = v_user_id;
  if not found then return 'null'::jsonb; end if;

  -- RLS excludes hidden players before counting strictly better visible scores.
  if v_direction = 'asc' then
    select 1 + count(*) into v_rank from public.game_best_scores as best
      where best.leaderboard_id = p_board_id and best.score < v_mine.score;
  else
    select 1 + count(*) into v_rank from public.game_best_scores as best
      where best.leaderboard_id = p_board_id and best.score > v_mine.score;
  end if;
  return pg_catalog.jsonb_build_object('playerId', v_user_id, 'displayName', v_mine.display_name,
    'score', v_mine.score, 'rank', v_rank, 'achievedAt', v_mine.achieved_at);
end;
$function$;

revoke all on function public.sg_list_leaderboards(), public.sg_get_entries(text, integer, jsonb),
  public.sg_get_my_score(text) from public, anon, authenticated, service_role;
grant execute on function public.sg_list_leaderboards(), public.sg_get_entries(text, integer, jsonb) to anon, authenticated;
grant execute on function public.sg_get_my_score(text) to authenticated;


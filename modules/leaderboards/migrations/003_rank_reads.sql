-- Additive read APIs. No table grants or policies change; every read uses RLS.
create function public.sg_list_leaderboards()
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
  from public.game_leaderboards as board where board.enabled;
$function$;

create function public.sg_get_entries(
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
  select board.sort_direction into v_direction from public.game_leaderboards as board
    where board.id = p_board_id and board.enabled;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEADERBOARD_NOT_FOUND';
  end if;

  if p_cursor is not null then
    if pg_catalog.octet_length(p_cursor::text) > 4096
      or pg_catalog.jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CURSOR';
    end if;
    if (select count(*) from pg_catalog.jsonb_object_keys(p_cursor)) <> 4
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
        select pg_catalog.jsonb_build_object('boardId', $1, 'score', score,
          'achievedAt', achieved_at, 'playerId', user_id)::text
        from numbered where position = $5
      ) else null end
    ) from numbered
  $query$, case when v_direction = 'asc' then 'asc' else 'desc' end,
    v_continuation, v_order, v_order)
    into v_result using p_board_id, v_score, v_time, v_player, p_limit;
  return v_result;
end;
$function$;

create function public.sg_get_my_score(p_board_id text)
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
    where board.id = p_board_id and board.enabled;
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

-- One implementation supports the base and Admin schemas without changing
-- their visibility policies or cursor formats. Admin generations are detected
-- from the already caller-visible board row, not from privileged schema access.
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
  select board.sort_direction,(to_jsonb(board)->>'generation')::bigint into v_direction,v_generation from public.game_leaderboards as board
    where board.id = p_board_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEADERBOARD_NOT_FOUND';
  end if;

  if p_cursor is not null then
    if pg_catalog.octet_length(p_cursor::text) > 4096
      or pg_catalog.jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CURSOR';
    end if;
    if (select count(*) from pg_catalog.jsonb_object_keys(p_cursor)) <> (case when v_generation is null then 4 else 5 end)
      or (v_generation is not null and p_cursor->>'generation' is distinct from v_generation::text)
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

  -- Seek only candidate rows, then count preceding visible rows for exact ranks.
  -- Splitting the tied cursor group from later scores permits index seeking in
  -- both directions. Only limit+1 candidates enter the ranking windows/name join.
  -- Counts retain RLS and remain O(preceding visible rows), not constant-time.
  execute pg_catalog.format($query$
    with candidates as materialized (
      (select user_id,score,achieved_at from public.game_best_scores
       where leaderboard_id=$1 and $2 is not null and score=$2 and (achieved_at,user_id)>($3,$4)
       order by %3$s limit ($5+1))
      union all
      (select user_id,score,achieved_at from public.game_best_scores
       where leaderboard_id=$1 and ($2 is null or case when '%1$s'='asc' then score>$2 else score<$2 end)
       order by %3$s limit ($5+1))
      order by %3$s limit ($5+1)
    ), first_entry as materialized (
      select * from candidates order by %3$s limit 1
    ), preceding as materialized (
      select count(*) filter(where b.score<>f.score) as better,
        count(*) filter(where b.score=f.score) as skipped_ties
      from first_entry f join public.game_best_scores b on b.leaderboard_id=$1
      where $2 is not null and ((case when '%1$s'='asc' then b.score<f.score else b.score>f.score end)
        or (b.score=f.score and (b.achieved_at,b.user_id)<(f.achieved_at,f.user_id)))
    ), ranked as (
      select c.*,pg_catalog.rank() over(order by score %1$s) as local_rank from candidates c
    ), page as (
      select r.user_id,p.display_name,r.score,r.achieved_at,
        x.better+r.local_rank+case when r.score=f.score then 0 else x.skipped_ties end as competition_rank
      from ranked r cross join preceding x cross join first_entry f
      join public.game_players p on p.user_id=r.user_id
    ), numbered as (
      select *,pg_catalog.row_number() over(order by %4$s) as position from page
    )
    select pg_catalog.jsonb_build_object(
      'entries', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'playerId', user_id, 'displayName', display_name, 'score', score,
        'rank', competition_rank, 'achievedAt', achieved_at
      ) order by position) filter (where position <= $5), '[]'::jsonb),
      'nextCursor', case when count(*) > $5 then (
        select (pg_catalog.jsonb_build_object('boardId', $1, 'score', score,
          'achievedAt', achieved_at, 'playerId', user_id)||case when $6 is null then '{}'::jsonb else jsonb_build_object('generation',$6) end)::text
        from numbered where position = $5
      ) else null end
    ) from numbered
  $query$, case when v_direction = 'asc' then 'asc' else 'desc' end,
    v_continuation, v_order, v_order)
    into v_result using p_board_id, v_score, v_time, v_player, p_limit, v_generation;
  return v_result;
end;
$function$;


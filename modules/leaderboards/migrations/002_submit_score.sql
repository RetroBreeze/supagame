-- Requires leaderboard schema and core player schema. Apply once via the ledger.
-- No submission RPC existed before this migration, so legitimate events cannot
-- predate it. NOT NULL deliberately rejects manually seeded legacy events: their
-- historical best cannot be reconstructed safely from today's personal best.
alter table sg_private.game_submission_events
  add column best_score bigint not null
  check (best_score between -9007199254740991 and 9007199254740991);

create function public.sg_submit_score(
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
    (user_id, leaderboard_id, submission_key, submitted_score, outcome, created_at, best_score)
    values (v_user_id, p_board_id, p_submission_key, p_score, v_outcome, v_now, v_best_score);
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'score', p_score, 'bestScore', v_best_score);
end;
$function$;

revoke all on function public.sg_submit_score(text, bigint, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.sg_submit_score(text, bigint, uuid) to authenticated;

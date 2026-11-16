-- Account deletion and live profile-change broadcasts filter by user without a
-- board. Ranking indexes begin with leaderboard_id and do not cover this lookup.
create index game_best_scores_user_idx on public.game_best_scores(user_id);

-- Board deletion checks all event generations. An installed Admin history index
-- already has the necessary leading column; do not duplicate that coverage.
do $$begin
 if not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
  where i.indrelid='sg_private.game_submission_events'::regclass and a.attname='leaderboard_id'
  and i.indisvalid and i.indpred is null and i.indexprs is null) then
  create index game_submission_events_board_idx on sg_private.game_submission_events(leaderboard_id);
 end if;
end;$$;

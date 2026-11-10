-- Optional live-leaderboards 0.1.0; requires core and leaderboards 0.1.0.
-- Private, receive-only board hints. Never send row images or submission keys.
create policy supagame_live_receive on realtime.messages
  for select to authenticated using (
    extension = 'broadcast' and exists (
      select 1 from public.game_leaderboards b
      where b.enabled and realtime.topic() = 'supagame:leaderboard:' || b.id
    )
  );
-- Restrictive policy prevents other permissive policies granting client sends
-- in our namespace without affecting unrelated application topics.
create policy supagame_live_no_client_send on realtime.messages
  as restrictive for insert to anon, authenticated
  with check (realtime.topic() not like 'supagame:leaderboard:%');

create function sg_private.live_invalidate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare board_id text;
begin
  if tg_table_name = 'game_best_scores' then
    if tg_op = 'UPDATE' and new.score = old.score and new.achieved_at = old.achieved_at then return null; end if;
    board_id := case when tg_op = 'DELETE' then old.leaderboard_id else new.leaderboard_id end;
    if exists (select 1 from public.game_players where user_id = case when tg_op = 'DELETE' then old.user_id else new.user_id end and not hidden)
      and exists (select 1 from public.game_leaderboards where id = board_id and enabled) then
      perform realtime.send(jsonb_build_object('boardId', board_id), 'changed', 'supagame:leaderboard:' || board_id, true);
    end if;
  elsif tg_table_name = 'game_players' then
    if tg_op = 'UPDATE' and (new.hidden = old.hidden and (new.hidden or new.display_name is not distinct from old.display_name)) then return null; end if;
    if tg_op = 'DELETE' and old.hidden then return old; end if;
    for board_id in select s.leaderboard_id from public.game_best_scores s join public.game_leaderboards b on b.id = s.leaderboard_id where s.user_id = old.user_id and b.enabled loop
      perform realtime.send(jsonb_build_object('boardId', board_id), 'changed', 'supagame:leaderboard:' || board_id, true);
    end loop;
  else
    if tg_op = 'UPDATE' and new.enabled = old.enabled and new.sort_direction = old.sort_direction then return new; end if;
    perform realtime.send(jsonb_build_object('boardId', old.id), 'changed', 'supagame:leaderboard:' || old.id, true);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function sg_private.live_invalidate() from public, anon, authenticated;
create trigger supagame_live_scores after insert or update or delete on public.game_best_scores for each row execute function sg_private.live_invalidate();
create trigger supagame_live_profiles after update on public.game_players for each row execute function sg_private.live_invalidate();
-- Before delete retains the board memberships before FK cascading deletion.
create trigger supagame_live_player_delete before delete on public.game_players for each row execute function sg_private.live_invalidate();
create trigger supagame_live_boards before update or delete on public.game_leaderboards for each row execute function sg_private.live_invalidate();

-- Additive optional module. Award from accepted events, never a client claim.
create table public.game_achievements (
 id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 title text not null check (length(title) between 1 and 120),
 description text not null check (length(description) <= 1000),
 icon text check (length(icon) <= 512),
 category text check (length(category) <= 120),
 metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
 condition_type text not null check (condition_type = 'score_threshold'),
 leaderboard_id text not null references public.game_leaderboards(id),
 threshold bigint not null check (threshold between 0 and 9007199254740991)
);
create index game_achievements_board_threshold on public.game_achievements(leaderboard_id, threshold, id);
create table public.game_player_achievements (
 user_id uuid not null references public.game_players(user_id) on delete cascade,
 achievement_id text not null references public.game_achievements(id),
 unlocked_at timestamptz not null,
 historical boolean not null,
 primary key(user_id, achievement_id)
);
alter table public.game_achievements enable row level security;
alter table public.game_player_achievements enable row level security;
revoke all on public.game_achievements, public.game_player_achievements from public, anon, authenticated;
grant select on public.game_achievements, public.game_player_achievements to authenticated;
create policy achievements_read on public.game_achievements for select to authenticated using (true);
create policy achievements_own on public.game_player_achievements for select to authenticated using (user_id = (select auth.uid()));

create function sg_private.award_score_achievements() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.game_player_achievements(user_id, achievement_id, unlocked_at, historical)
 select new.user_id, a.id, new.created_at, false from public.game_achievements a
 where a.leaderboard_id = new.leaderboard_id and a.condition_type = 'score_threshold'
 and new.submitted_score >= a.threshold order by a.threshold, a.id
 on conflict (user_id, achievement_id) do nothing;
 return new;
end $$;
revoke all on function sg_private.award_score_achievements() from public, anon, authenticated;
create trigger award_score_achievements after insert on sg_private.game_submission_events
for each row execute function sg_private.award_score_achievements();

-- Lock the board just as submissions do: registration/backfill cannot miss a
-- concurrent accepted result. Only descending boards support >= progress today.
create function sg_private.prepare_achievement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.game_leaderboards where id = new.leaderboard_id and sort_direction = 'desc' for update;
 if not found then raise exception 'ACHIEVEMENT_REQUIRES_DESC_BOARD'; end if;
 return new;
end $$;
create function sg_private.backfill_achievement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.game_player_achievements(user_id, achievement_id, unlocked_at, historical)
 select b.user_id, new.id, b.achieved_at, true from public.game_best_scores b
 where b.leaderboard_id = new.leaderboard_id and b.score >= new.threshold
 on conflict (user_id, achievement_id) do nothing;
 return new;
end $$;
revoke all on function sg_private.prepare_achievement(), sg_private.backfill_achievement() from public, anon, authenticated;
create trigger prepare_achievement before insert on public.game_achievements for each row execute function sg_private.prepare_achievement();
create trigger backfill_achievement after insert on public.game_achievements for each row execute function sg_private.backfill_achievement();

create function public.sg_get_achievements() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_result jsonb;
begin
 if v_user is null or not exists(select 1 from auth.users where id = v_user) then
 raise exception using errcode = '28000', message = 'UNAUTHORIZED'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
 'id', a.id, 'title', a.title, 'description', a.description, 'icon', a.icon,
 'category', a.category, 'metadata', a.metadata,
 'progress', jsonb_build_object('current', greatest(0, coalesce(b.score,0)), 'threshold', a.threshold),
 'unlocked', u.achievement_id is not null, 'unlockedAt', u.unlocked_at,
 'historical', coalesce(u.historical,false)
 ) order by a.threshold, a.id), '[]'::jsonb) into v_result
 from public.game_achievements a
 left join public.game_best_scores b on b.leaderboard_id = a.leaderboard_id and b.user_id = v_user
 left join public.game_player_achievements u on u.achievement_id = a.id and u.user_id = v_user;
 return v_result;
end $$;
revoke all on function public.sg_get_achievements() from public, anon, authenticated, service_role;
grant execute on function public.sg_get_achievements() to authenticated;

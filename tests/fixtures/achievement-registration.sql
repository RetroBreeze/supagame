-- Supagame achievement coins-500; immutable definition, automatic historical backfill.
do $supagame$
declare d jsonb := E'{"id":"coins-500","title":"Collector","description":"Collect 500 in one run.","icon":"coin","category":"coins","metadata":{},"condition":{"type":"score_threshold","leaderboardId":"coins","threshold":500}}'::jsonb;
begin
 insert into public.game_achievements(id,title,description,icon,category,metadata,condition_type,leaderboard_id,threshold)
 values(d->>'id',d->>'title',d->>'description',d->>'icon',d->>'category',d->'metadata',d->'condition'->>'type',d->'condition'->>'leaderboardId',(d->'condition'->>'threshold')::bigint) on conflict(id) do nothing;
 if not exists(select 1 from public.game_achievements a where a.id=d->>'id' and a.title=d->>'title' and a.description=d->>'description' and a.icon is not distinct from d->>'icon' and a.category is not distinct from d->>'category' and a.metadata=d->'metadata' and a.condition_type=d->'condition'->>'type' and a.leaderboard_id=d->'condition'->>'leaderboardId' and a.threshold=(d->'condition'->>'threshold')::bigint) then raise exception 'SUPAGAME_ACHIEVEMENT_CONFLICT'; end if;
end $supagame$;

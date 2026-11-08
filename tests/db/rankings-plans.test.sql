-- Representative query-plan checks, not a production-scale benchmark.
-- EXPLAIN of a PL/pgSQL call hides nested plans, so explain its ranked page query
-- directly under the real API role, including joins and RLS. Observe default
-- plans separately from the ordered-index capability check below.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users (id)
select ('52000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,10000) n;
insert into public.game_players (user_id, display_name)
select id, 'Plan Player' from auth.users where id::text like '52000000-%';
insert into public.game_leaderboards (id, kind, sort_direction) values ('plan-asc','time','asc'), ('plan-desc','points','desc');
insert into public.game_best_scores (leaderboard_id,user_id,score,achieved_at,submission_key)
select board, id, right(id::text,12)::bigint, '2026-01-01T00:00:00Z', gen_random_uuid()
from auth.users cross join (values ('plan-asc'),('plan-desc')) boards(board) where id::text like '52000000-%';
analyze public.game_players;
analyze public.game_leaderboards;
analyze public.game_best_scores;

create function pg_temp.explain_query(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin execute 'explain (analyze, buffers, format json) ' || statement into result; return result; end $$;
create temporary table plans (direction text, stage text, plan jsonb);
grant insert, select on plans to anon;
set local role anon;
insert into plans
select direction, stage, pg_temp.explain_query(format($query$
  select * from (
    select best.user_id, player.display_name, best.score, best.achieved_at,
      rank() over (order by best.score %s) as competition_rank
    from public.game_best_scores best join public.game_players player on player.user_id = best.user_id
    where best.leaderboard_id = %L
  ) ranked where %s order by score %s, achieved_at, user_id limit 51
$query$, direction, 'plan-' || direction,
  case when stage = 'first' then 'true' when direction = 'asc' then 'score > 9000' else 'score < 1001' end, direction))
from (values ('asc'), ('desc')) directions(direction) cross join (values ('first'), ('deep')) stages(stage);

select is((plan->0->'Plan'->>'Actual Rows')::integer, 51, direction || ' ' || stage || ' page produces only limit + 1 rows') from plans;
select diag(direction || ' ' || stage || ' default plan: ranking index=' ||
  jsonb_path_exists(plan, '$.** ? (@."Index Name" == "game_best_scores_rank_asc_idx" || @."Index Name" == "game_best_scores_rank_desc_idx")') ||
  ', full-board sort=' || jsonb_path_exists(plan, '$.** ? (@."Node Type" == "Sort" && @.Plans[0]."Actual Rows" > 200)')) from plans;
-- Check an ordered index path remains available without asserting that the cost
-- model must choose it. These settings affect ONLY this diagnostic transaction;
-- default plans above and actual RPC calls below use normal planner settings.
set local enable_seqscan = off;
set local enable_hashjoin = off;
set local enable_mergejoin = off;
set local enable_sort = off;
select ok(jsonb_path_exists(pg_temp.explain_query(format($q$
  select * from (
    select best.user_id, player.display_name, best.score, best.achieved_at,
      rank() over (order by best.score %s) as competition_rank
    from public.game_best_scores best join public.game_players player on player.user_id = best.user_id
    where best.leaderboard_id = %L
  ) ranked order by score %s, achieved_at, user_id limit 51
$q$, direction, 'plan-' || direction, direction)),
  '$.** ? (@."Index Name" == "game_best_scores_rank_asc_idx" || @."Index Name" == "game_best_scores_rank_desc_idx")'),
  direction || ' ranked query has an available ordered ranking-index path')
from (values ('asc'), ('desc')) directions(direction);
set local enable_seqscan = on;
set local enable_hashjoin = on;
set local enable_mergejoin = on;
set local enable_sort = on;
-- Exercise the actual RPC on the same larger fixture, not only the query shape.
select is(public.sg_get_entries('plan-asc',50)->'entries'->0->>'score', '1', 'actual ASC RPC on 10,000 players');
select is(public.sg_get_entries('plan-desc',50)->'entries'->0->>'score', '10000', 'actual DESC RPC on 10,000 players');
select is(public.sg_get_entries('plan-asc',50,'{"boardId":"plan-asc","score":9000,"achievedAt":"2026-01-01T00:00:00Z","playerId":"52000000-0000-4000-8000-000000009000"}')->'entries'->0->>'rank', '9001', 'deep ASC RPC retains global rank');
select is(public.sg_get_entries('plan-desc',50,'{"boardId":"plan-desc","score":1001,"achievedAt":"2026-01-01T00:00:00Z","playerId":"52000000-0000-4000-8000-000000001001"}')->'entries'->0->>'rank', '9001', 'deep DESC RPC retains global rank');
select diag(direction || ' ' || stage || ' page execution: ' || (plan->0->>'Execution Time') || ' ms') from plans;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"52000000-0000-4000-8000-000000005000"}';
select is(public.sg_get_my_score('plan-asc')->>'rank', '5000', 'actual personal ASC rank on larger board');
select is(public.sg_get_my_score('plan-desc')->>'rank', '5001', 'actual personal DESC rank on larger board');
select ok(jsonb_path_exists(pg_temp.explain_query($q$select score, achieved_at from public.game_best_scores
  where leaderboard_id = 'plan-asc' and user_id = '52000000-0000-4000-8000-000000005000'$q$),
  '$.** ? (@."Index Name" == "game_best_scores_pkey")'), 'personal score lookup uses its composite primary key');
reset role;
select * from finish();
rollback;

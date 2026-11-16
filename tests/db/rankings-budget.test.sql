begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local jit=off;
insert into auth.users(id) select ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,10000)n;
insert into public.game_players(user_id,display_name,hidden) select id,'Budget',right(id::text,12)::integer%10=0 from auth.users where id::text like 'b2000000-%';
insert into public.game_leaderboards(id,kind,sort_direction) values('budget-asc','time','asc'),('budget-desc','points','desc');
insert into public.game_best_scores(leaderboard_id,user_id,score,achieved_at,submission_key)
select b,id,right(id::text,12)::bigint/100,'2026-01-01Z',gen_random_uuid() from auth.users cross join(values('budget-asc'),('budget-desc'))boards(b) where id::text like 'b2000000-%';
analyze public.game_best_scores;analyze public.game_players;analyze public.game_leaderboards;
create function pg_temp.page_plan(direction text) returns jsonb language plpgsql as $$
declare q text;p jsonb;
begin
 q:=substring(pg_get_functiondef('public.sg_get_entries(text,integer,jsonb)'::regprocedure) from '(?s)\$query\$(.*?)\$query\$');
 q:=format(q,direction,case when direction='asc' then '(score,achieved_at,user_id)>($2,$3,$4)' else '(score<$2 or (score=$2 and (achieved_at,user_id)>($3,$4)))' end,'score '||direction||',achieved_at,user_id','score '||direction||',achieved_at,user_id');
 execute 'explain(analyze,buffers,format json) '||q into p using 'budget-'||direction,50::bigint,'2026-01-01Z'::timestamptz,'b2000000-0000-4000-8000-000000005025'::uuid,50,1;
 return p;
end;$$;
create temporary table oracle as select leaderboard_id,user_id,rank() over(partition by leaderboard_id order by case when leaderboard_id='budget-asc' then score else -score end) expected_rank from public.game_best_scores where leaderboard_id like 'budget-%' and user_id in(select user_id from public.game_players where not hidden);
create unique index on oracle(leaderboard_id,user_id);grant select on oracle to anon,authenticated;
set local role anon;
select ok(not jsonb_path_exists(pg_temp.page_plan(d),'$.** ? (@."Node Type" == "WindowAgg" && @."Actual Rows" > 51)'),d||' window ranking processes at most limit+1 candidates') from(values('asc'),('desc'))directions(d);
-- The cursor splits a tie: its continuation must retain the global rank and
-- the following group's rank must include tied players before the cursor.
create function pg_temp.assert_pages(d text) returns void language plpgsql as $$
declare cursor jsonb; page jsonb; e jsonb; expected_rank bigint; seen uuid[]:='{}';
begin
 loop
  page:=public.sg_get_entries('budget-'||d,37,cursor);
  for e in select value from jsonb_array_elements(page->'entries') loop
   if (e->>'playerId')::uuid=any(seen) then raise exception 'duplicate page entry';end if;
   seen:=array_append(seen,(e->>'playerId')::uuid);
   select o.expected_rank into expected_rank from oracle o where o.leaderboard_id='budget-'||d and o.user_id=(e->>'playerId')::uuid;
   if expected_rank<>(e->>'rank')::bigint then raise exception 'incorrect rank';end if;
  end loop;
  cursor:=(page->>'nextCursor')::jsonb;exit when cursor is null;
 end loop;
 if cardinality(seen)<>9000 then raise exception 'missing visible entries';end if;
end;$$;
select lives_ok($$select pg_temp.assert_pages('asc')$$,'ASC hidden players and extensive ties have exact ranks without gaps');
select lives_ok($$select pg_temp.assert_pages('desc')$$,'DESC hidden players and extensive ties have exact ranks without gaps');
reset role;select * from finish();rollback;

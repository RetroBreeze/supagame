begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select ok(exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
 where i.indrelid=relation::regclass and a.attname=column_name and i.indisvalid and i.indpred is null and i.indexprs is null),reason)
from(values
 ('public.game_best_scores','user_id','player deletion and live-profile lookup have a user-leading index'),
 ('sg_private.game_submission_events','leaderboard_id','board FK checks are covered without requiring Admin'),
 ('public.game_player_achievements','achievement_id','achievement FK checks avoid scanning player-leading keys')
) targets(relation,column_name,reason);
insert into auth.users(id) values('ca100000-0000-4000-8000-000000000001');
insert into public.game_players(user_id,display_name) values('ca100000-0000-4000-8000-000000000001','FK fixture');
insert into public.game_leaderboards(id,kind,sort_direction) values('fk-cascade','points','desc'),('fk-account','points','desc');
insert into public.game_best_scores(leaderboard_id,user_id,score,submission_key) select b,'ca100000-0000-4000-8000-000000000001',10,gen_random_uuid() from unnest(array['fk-cascade','fk-account'])b;
insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,best_score) select user_id,leaderboard_id,submission_key,score,'best',score from public.game_best_scores where leaderboard_id like 'fk-%';
delete from public.game_leaderboards where id='fk-cascade';
select is((select count(*) from public.game_best_scores where leaderboard_id='fk-cascade'),0::bigint,'board deletion cascades scores');
select is((select count(*) from sg_private.game_submission_events where leaderboard_id='fk-cascade'),0::bigint,'board deletion cascades submission history');
insert into public.game_achievements(id,title,description,condition_type,leaderboard_id,threshold) values('fk-award','FK','FK','score_threshold','fk-account',1);
select throws_ok($$delete from public.game_achievements where id='fk-award'$$,'23503',null,'achievement deletion still rejects referenced unlocks');
delete from auth.users where id='ca100000-0000-4000-8000-000000000001';
select is((select count(*) from public.game_best_scores where leaderboard_id='fk-account'),0::bigint,'account deletion cascades remaining best scores');
select is((select count(*) from public.game_player_achievements where achievement_id='fk-award'),0::bigint,'account deletion cascades unlocks');
select lives_ok($$delete from public.game_achievements where id='fk-award'$$,'unreferenced definition remains deletable');
select * from finish();rollback;

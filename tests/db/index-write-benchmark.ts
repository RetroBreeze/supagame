// Paired index-maintenance measurements on one rollback-only local fixture.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const setup=`begin;set local statement_timeout='180s';set local jit=off;
alter table public.game_best_scores disable trigger user;
alter table sg_private.game_submission_events disable trigger user;
insert into auth.users(id) select ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,100000)n;
insert into public.game_players(user_id,display_name) select id,'Index fixture' from auth.users where id::text like 'b3000000-%';
insert into public.game_leaderboards(id,kind,sort_direction) values('write-base','points','desc'),('write-target','points','desc');
insert into public.game_achievements(id,title,description,condition_type,leaderboard_id,threshold) values('write-base','Index','Index','score_threshold','write-base',1),('write-target','Index','Index','score_threshold','write-base',999999);
insert into public.game_best_scores(leaderboard_id,user_id,score,submission_key) select 'write-base',id,1,gen_random_uuid() from auth.users where id::text like 'b3000000-%';
insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,best_score) select user_id,leaderboard_id,submission_key,score,'best',score from public.game_best_scores where leaderboard_id='write-base';
insert into public.game_player_achievements(user_id,achievement_id,unlocked_at,historical) select user_id,'write-base',now(),true from public.game_best_scores where leaderboard_id='write-base';
alter table public.game_best_scores enable trigger user;
alter table sg_private.game_submission_events enable trigger user;
create temporary table write_users as select user_id from public.game_best_scores where leaderboard_id='write-base' order by user_id limit 1000;
analyze public.game_best_scores;analyze sg_private.game_submission_events;analyze public.game_player_achievements;analyze write_users;
drop index public.game_best_scores_user_idx;
drop index sg_private.game_submission_events_board_idx;
drop index public.game_player_achievements_definition_idx;
create function pg_temp.measure(q text) returns jsonb language plpgsql as $$declare p jsonb;begin execute 'explain(analyze,buffers,format json) '||q into p;return p;end;$$;
`;
const statements={
 bestScores:"insert into public.game_best_scores(leaderboard_id,user_id,score,submission_key) select 'write-target',user_id,1,gen_random_uuid() from write_users",
 events:"insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,best_score) select user_id,'write-base',gen_random_uuid(),1,'not_best',1 from write_users",
 unlocks:"insert into public.game_player_achievements(user_id,achievement_id,unlocked_at,historical) select user_id,'write-target',now(),false from write_users",
};
let sql=setup;
for(const phase of ['baseline','optimized']){
 if(phase==='optimized')sql+=`create index game_best_scores_user_idx on public.game_best_scores(user_id);
create index game_submission_events_board_idx on sg_private.game_submission_events(leaderboard_id);
create index game_player_achievements_definition_idx on public.game_player_achievements(achievement_id);
select jsonb_build_object('kind','sizes','bytes',(select jsonb_object_agg(indexrelname,pg_relation_size(indexrelid)) from pg_stat_user_indexes where indexrelname in ('game_best_scores_user_idx','game_submission_events_board_idx','game_player_achievements_definition_idx')));
`;
 for(let sample=1;sample<=3;sample++)for(const [name,query] of Object.entries(statements))sql+=`savepoint sample;
select jsonb_build_object('kind','write','phase','${phase}','table','${name}','sample',${sample},'rows',1000,'plan',pg_temp.measure($q$${query}$q$));
rollback to sample;release sample;
`;
}
sql+='rollback;';
const output=execFileSync('docker',['exec','-i','supabase_db_supagame-schema-tests','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:sql,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024});
const records=output.trim().split('\n').filter(s=>s.startsWith('{')).map(s=>JSON.parse(s));
mkdirSync('docs/verification/pre-release-performance',{recursive:true});
writeFileSync('docs/verification/pre-release-performance/index-writes.json',JSON.stringify({fixtureRowsPerTable:100000,samples:3,records},null,2)+'\n');
console.log(`Captured ${records.length} paired index-write/size records`);

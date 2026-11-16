// Reproducible, transaction-rolled-back fixtures in the fixed local test database.
// No hosted target, destructive reset, production data, or Auth credentials.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const phase=process.argv[2];
if(!['baseline','optimized'].includes(phase ?? '')) throw new Error('Use baseline or optimized');
const sizes=(process.argv[3]??'1000,10000,100000').split(',').map(Number);
if(sizes.some(n=>![1000,10000,100000,1000000].includes(n))) throw new Error('Unsupported benchmark size');
const destination='docs/verification/pre-release-performance'; mkdirSync(destination,{recursive:true});
const records:unknown[]=[];
const original=readFileSync('modules/leaderboards/migrations/003_rank_reads.sql','utf8');
const originalReader=original.slice(original.indexOf('create function public.sg_get_entries'),original.indexOf('create function public.sg_get_my_score')).replace('create function','create or replace function');
const admin=readFileSync('modules/admin/migrations/001_admin.sql','utf8');
for(const size of sizes) for(const configuration of ['standard','admin']) {
 console.log(`Measuring ${phase}, ${configuration}, ${size} players`);
 const patches=configuration==='admin' ? admin+(phase==='optimized' && existsSync('modules/admin/migrations/002_rank_performance.sql') ? readFileSync('modules/admin/migrations/002_rank_performance.sql','utf8'):'') : '';
 const sql=`begin;
set local statement_timeout='180s'; set local jit=off; set local work_mem='16MB';
${phase==='baseline' ? originalReader+"\ndrop index if exists public.game_best_scores_user_idx; drop index if exists sg_private.game_submission_events_board_idx; drop index if exists public.game_player_achievements_definition_idx;" : ''}
${patches}
alter table public.game_best_scores disable trigger user;
insert into auth.users(id) select ('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,${size}) n;
insert into public.game_players(user_id,display_name,hidden) select id,'Benchmark',right(id::text,12)::bigint%10=0 from auth.users where id::text like 'b1000000-%';
insert into public.game_leaderboards(id,kind,sort_direction) values ('bench-asc','time','asc'),('bench-desc','points','desc'),('bench-ties-asc','time','asc'),('bench-ties-desc','points','desc'),('bench-write','points','desc');
insert into public.game_best_scores(leaderboard_id,user_id,score,achieved_at,submission_key)
select b,id,case when b like '%ties%' then right(id::text,12)::bigint/100 else right(id::text,12)::bigint end,'2026-01-01Z',gen_random_uuid()
from auth.users cross join (values('bench-asc'),('bench-desc'),('bench-ties-asc'),('bench-ties-desc')) boards(b) where id::text like 'b1000000-%';
insert into sg_private.game_submission_events(user_id,leaderboard_id,submission_key,submitted_score,outcome,best_score)
select user_id,leaderboard_id,submission_key,score,'best',score from public.game_best_scores where leaderboard_id='bench-asc';
insert into public.game_achievements(id,title,description,condition_type,leaderboard_id,threshold) values('bench-achievement','Benchmark','Benchmark','score_threshold','bench-desc',1);
insert into public.game_player_achievements(user_id,achievement_id,unlocked_at,historical) select user_id,'bench-achievement',now(),true from public.game_best_scores where leaderboard_id='bench-asc' on conflict do nothing;
alter table public.game_best_scores enable trigger user;
analyze public.game_players; analyze public.game_best_scores; analyze public.game_leaderboards; analyze sg_private.game_submission_events; analyze public.game_player_achievements;
create function pg_temp.plan(q text) returns jsonb language plpgsql as $plan$ declare p jsonb; begin execute 'explain(analyze,buffers,format json) '||q into p; return p; end $plan$;
select jsonb_build_object('kind','indexes','size',${size},'configuration','${configuration}','phase','${phase}',
 'bytes',(select jsonb_object_agg(indexrelname,pg_relation_size(indexrelid)) from pg_stat_user_indexes where relname in ('game_best_scores','game_submission_events','game_player_achievements')),
 'playerLookup',pg_temp.plan($q$select leaderboard_id from public.game_best_scores where user_id='b1000000-0000-4000-8000-000000000001'$q$),
 'boardForeignKey',pg_temp.plan($q$select 1 from sg_private.game_submission_events where leaderboard_id='bench-absent' for key share$q$),
 'achievementForeignKey',pg_temp.plan($q$select 1 from public.game_player_achievements where achievement_id='bench-absent' for key share$q$),
 'write',pg_temp.plan($q$insert into public.game_best_scores(leaderboard_id,user_id,score,submission_key) select 'bench-write',user_id,1,gen_random_uuid() from public.game_best_scores where leaderboard_id='bench-asc' limit 1000$q$));
create function pg_temp.bench(board text,direction text,depth integer) returns jsonb language plpgsql as $bench$
declare cur jsonb; p jsonb; rpc jsonb; q text; score bigint; at_time timestamptz; player uuid;
begin
 if depth>0 then
  execute format('select jsonb_build_object(''boardId'',$1,''score'',score,''achievedAt'',achieved_at,''playerId'',user_id) from public.game_best_scores where leaderboard_id=$1 order by score %s,achieved_at,user_id offset $2 limit 1',direction) into cur using board,depth-1;
  score:=(cur->>'score')::bigint; at_time:=(cur->>'achievedAt')::timestamptz; player:=(cur->>'playerId')::uuid;
  ${configuration==='admin' ? "cur:=cur||jsonb_build_object('generation',1);" : ''}
 end if;
 q:=substring(pg_get_functiondef('public.sg_get_entries(text,integer,jsonb)'::regprocedure) from '(?s)\\$query\\$(.*?)\\$query\\$');
 q:=format(q,direction,case when depth=0 then 'true' else format('(score %s $2 or (score=$2 and (achieved_at,user_id)>($3,$4)))',case when direction='asc' then '>' else '<' end) end,
 'score '||direction||', achieved_at, user_id','score '||direction||', achieved_at, user_id',case when direction='asc' then '<' else '>' end);
 execute 'explain(analyze,buffers,format json) '||q into p using board,score,at_time,player,50,1;
 execute 'explain(analyze,buffers,format json) select public.sg_get_entries($1,$2,$3)' into rpc using board,50,cur;
 return jsonb_build_object('kind','pagination','size',${size},'configuration','${configuration}','phase','${phase}','role',current_user,'board',board,'depth',depth,'plan',p,'rpc',rpc);
end;$bench$;
set local role anon;
select pg_temp.bench(b,d,n) from (values('bench-asc','asc'),('bench-desc','desc'),('bench-ties-asc','asc'),('bench-ties-desc','desc'))boards(b,d) cross join (values(0),(${Math.floor(size*.45)}),(${Math.floor(size*.81)+25})) pages(n);
reset role;set local role authenticated;set local request.jwt.claims='{"sub":"b1000000-0000-4000-8000-000000000001"}';
select pg_temp.bench(b,d,n) from (values('bench-asc','asc'),('bench-desc','desc'),('bench-ties-asc','asc'),('bench-ties-desc','desc'))boards(b,d) cross join (values(0),(${Math.floor(size*.45)}),(${Math.floor(size*.81)+25})) pages(n);
reset role;rollback;
`;
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('docker',['exec','-i','supabase_db_supagame-schema-tests','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{stdio:['pipe','pipe','pipe']});
  let buffer='',errors='';
  child.stdout.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();for(let newline;(newline=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.startsWith('{'))records.push(JSON.parse(line));}});
  child.stderr.on('data',(chunk:Buffer)=>{errors+=chunk.toString();});child.on('error',reject);
  child.on('close',code=>{writeFileSync(join(destination,`${phase}-${sizes.join('-')}.json`),JSON.stringify({settings:{jit:false,workMem:'16MB',hiddenFraction:.1},records},null,2)+'\n');if(code===0)resolve();else reject(new Error(errors));});
  child.stdin.end(sql);
 });
 console.log(`Captured ${records.length} measurements`);
}

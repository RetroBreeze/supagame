import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { query, session, waitUntil } from './local-sessions.ts';

const auth=(user:string)=>`begin;set local role authenticated;set local request.jwt.claims='{"sub":"${user}"}';`;
const prepare=(id:string)=>`select public.sg_cloud_save('prepare','race','${JSON.stringify({generation:'1',operationId:id,expectedRevision:0,schemaVersion:1,metadata:{},sizeBytes:8,checksum:'a'.repeat(64)})}');`;
const cleanup=(user:string)=>query(`delete from auth.users where id='${user}';delete from sg_private.save_objects where user_id='${user}';`);
for(const soft of [false,true]) for(const deletionFirst of [false,true]) {
 test(`${soft?'soft':'hard'} account deletion and reservation serialize (deletion first: ${deletionFirst})`,async()=>{
  const user=randomUUID(),id=randomUUID(),tag=`save-race-${randomUUID()}`;
  query(`insert into auth.users(id,is_anonymous) values('${user}',true)`);
  const deletion=soft?`update auth.users set deleted_at=clock_timestamp() where id='${user}';`:`delete from auth.users where id='${user}';`;
  const first=session((deletionFirst?'begin;'+deletion:auth(user)+prepare(id))+'\n\\echo READY\n');
  let second:ReturnType<typeof session>|undefined;
  try{
   await waitUntil(()=>first.state.stdout.includes('READY'),'first operation holds its transaction');
   second=session(`set application_name='${tag}';`+(deletionFirst?auth(user)+prepare(id):'begin;'+deletion)+'commit;');second.child.stdin.end();
   await waitUntil(()=>query(`select exists(select 1 from pg_stat_activity where application_name='${tag}' and cardinality(pg_blocking_pids(pid))>0)`)==='t','second operation waits on the Auth row');
   first.child.stdin.end('commit;');await first.finished;
   if(deletionFirst)await assert.rejects(second.finished,/UNAUTHORIZED/);else await second.finished;
   assert.equal(query(`select count(*) from sg_private.save_objects where user_id='${user}'`),deletionFirst?'0':'1');
   assert.throws(()=>query(auth(user)+"select public.sg_cloud_save('list');commit;"),/UNAUTHORIZED/);
  }finally{
   if(!first.child.stdin.writableEnded)first.child.stdin.end('rollback;');
   await Promise.allSettled([first.finished,...second?[second.finished]:[]]);cleanup(user);
  }
 });
}

test('two concurrent reservations cannot both take the last rate allowance',async()=>{
 const user=randomUUID(),last=randomUUID(),extra=randomUUID(),tag=`save-rate-${randomUUID()}`;
 const original=query('select max_pending from sg_private.save_config');
 query(`insert into auth.users(id,is_anonymous) values('${user}',true);update sg_private.save_config set max_pending=100;`);
 query(auth(user)+Array.from({length:59},()=>prepare(randomUUID())).join('\n')+'commit;');
 const first=session(auth(user)+prepare(last)+'\n\\echo READY\n');let second:ReturnType<typeof session>|undefined;
 try{
  await waitUntil(()=>first.state.stdout.includes('READY'),'last reservation holds lock');
  second=session(`set application_name='${tag}';`+auth(user)+prepare(extra)+'commit;');second.child.stdin.end();
  await waitUntil(()=>query(`select exists(select 1 from pg_stat_activity where application_name='${tag}' and cardinality(pg_blocking_pids(pid))>0)`)==='t','competing reservation waits');
  first.child.stdin.end('commit;');await first.finished;await assert.rejects(second.finished,/RATE_LIMITED/);
  assert.equal(query(`select count(*) from sg_private.save_objects where user_id='${user}'`),'60');
  assert.match(query(auth(user)+prepare(last)+'commit;'),new RegExp(last));
 }finally{
  if(!first.child.stdin.writableEnded)first.child.stdin.end('rollback;');
  await Promise.allSettled([first.finished,...second?[second.finished]:[]]);
  cleanup(user);query(`update sg_private.save_config set max_pending=${Number(original)}`);
 }
});

test('operator registry cleanup atomically fences a concurrent stale save',async()=>{
 const user=randomUUID(),id=randomUUID(),write=randomUUID(),tag=`save-cleanup-${randomUUID()}`;
 query(`insert into auth.users(id,is_anonymous) values('${user}',true);`);
 query(auth(user)+prepare(id)+`select public.sg_cloud_save('abort','race','{"generation":"1","operationId":"${id}"}');commit;`);
 const first=session(`begin;select sg_private.finish_save_cleanup(array['${user}/${id}']);\n\\echo READY\n`);
 let second:ReturnType<typeof session>|undefined;
 try{
  await waitUntil(()=>first.state.stdout.includes('READY'),'operator holds history lock');
  const request=JSON.stringify({generation:'1',operationId:write,expectedRevision:0,schemaVersion:1,metadata:{},data:{offline:true}});
  second=session(`set application_name='${tag}';`+auth(user)+`select public.sg_cloud_save('save','race','${request}');commit;`);second.child.stdin.end();
  await waitUntil(()=>query(`select exists(select 1 from pg_stat_activity where application_name='${tag}' and cardinality(pg_blocking_pids(pid))>0)`)==='t','save waits for atomic cleanup');
  first.child.stdin.end('commit;');await first.finished;
  assert.match(await second.finished,/SAVE_CONFLICT/);
  assert.equal(query(`select count(*) from public.game_saves where user_id='${user}'`),'0');
  assert.equal(query(`select generation from sg_private.save_state where user_id='${user}'`),'2');
 }finally{
  if(!first.child.stdin.writableEnded)first.child.stdin.end('rollback;');
  await Promise.allSettled([first.finished,...second?[second.finished]:[]]);cleanup(user);
 }
});

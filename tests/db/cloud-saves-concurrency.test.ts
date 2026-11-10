import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {query,session,waitUntil} from './local-sessions.ts';
test('concurrent save creates serialize; one wins and the stale writer receives the committed revision',async()=>{
 const user=randomUUID();query(`insert into auth.users(id,is_anonymous) values('${user}',true)`);
 const auth=`begin;set local role authenticated;set local request.jwt.claims='{"sub":"${user}"}';`;
 const payload=(coins:number)=>JSON.stringify({operationId:randomUUID(),expectedRevision:0,schemaVersion:1,metadata:{},data:{coins}});
 const first=session(`${auth}select public.sg_cloud_save('save','profile','${payload(1)}');\n\\echo READY\n`);
 let second:ReturnType<typeof session>|undefined;
 try{
  await waitUntil(()=>first.state.stdout.includes('READY'),'first write is held before commit');
  second=session(`${auth}select public.sg_cloud_save('save','profile','${payload(2)}');commit;`);second.child.stdin.end();
  first.child.stdin.end('commit;');await first.finished;const result=await second.finished;
  assert.match(result,/SAVE_CONFLICT/);assert.match(result,/"revision": 1/);
  assert.equal(query(`select data->>'coins' from public.game_saves where user_id='${user}'`),'1');
 }finally{if(!first.child.stdin.writableEnded)first.child.stdin.end('rollback;');await Promise.allSettled([first.finished,...second?[second.finished]:[]]);query(`delete from auth.users where id='${user}'`);}
});

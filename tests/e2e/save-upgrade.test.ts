import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { localProject } from './local-project.ts';
import { legacyTemplateFiles, templateFiles, migrationModule } from '../../packages/cli/src/lib/templates.ts';

// A fresh, test-owned Supabase project starts at the exact pre-remediation assets.
// Then normal migration up upgrades existing saves, receipts and recovery history.
test('0.1.4 database upgrades without replacing saves, backups or migration ledger', {timeout:600_000}, async t => {
 const project=await localProject(); t.after(()=>project.remove());
 const enabled=new Set(['core','leaderboards','cloud-saves','achievements','admin']);
 const legacy=legacyTemplateFiles('0.1.4').filter(f=>f.path.startsWith('supabase/migrations/') && enabled.has(migrationModule(f.path)!));
 const write=(path:string,content:Buffer)=>{mkdirSync(dirname(join(project.root,path)),{recursive:true});writeFileSync(join(project.root,path),content);};
 for(const f of legacy)write(f.path,f.content);
 const config=join(project.root,'supabase/config.toml');writeFileSync(config,readFileSync(config,'utf8').replace('[storage]\nenabled = false','[storage]\nenabled = true'));
 project.start();
 const sql=(query:string)=>execFileSync('docker',['exec','-i',`supabase_db_${project.id}`,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',timeout:30_000}).trim();
 const user='ca000000-0000-4000-8000-000000000001';
 const oldRequest={operationId:'da000000-0000-4000-8000-000000000001',expectedRevision:0,schemaVersion:1,metadata:{},data:{level:1}};
 sql(`insert into auth.users(id,is_anonymous) values('${user}',true);set request.jwt.claims='{"sub":"${user}"}';select public.sg_cloud_save('save','progress','${JSON.stringify(oldRequest)}');select public.sg_cloud_save('save','progress','${JSON.stringify({...oldRequest,operationId:'da000000-0000-4000-8000-000000000002',expectedRevision:1,backupExisting:true,data:{level:2}})}');`);
 const before=sql(`select jsonb_build_object('saves',(select jsonb_agg(s) from public.game_saves s),'backups',(select jsonb_agg(r) from sg_private.save_revisions r),'receipts',(select count(*) from sg_private.save_operations),'ledger',(select jsonb_agg(m order by version) from supabase_migrations.schema_migrations m));`);
 for(const f of templateFiles().filter(f=>f.path.startsWith('supabase/migrations/') && enabled.has(migrationModule(f.path)!))) {
  if(!legacy.some(old=>old.path===f.path))write(f.path,f.content);
 }
 project.supabase(['migration','up']); project.supabase(['migration','up']);
 const after=JSON.parse(sql(`select jsonb_build_object('saves',(select jsonb_agg(s) from public.game_saves s),'backups',(select jsonb_agg(r) from sg_private.save_revisions r),'receipts',(select count(*) from sg_private.save_operations),'ledger',(select jsonb_agg(m order by version) from supabase_migrations.schema_migrations m));`));
 const expected=JSON.parse(before);assert.deepEqual(after.saves,expected.saves);assert.deepEqual(after.backups,expected.backups);assert.equal(after.receipts,expected.receipts);
 for(const entry of expected.ledger)assert.deepEqual(after.ledger.find((r:{version:string})=>r.version===entry.version),entry);
 const auth=`set request.jwt.claims='{"sub":"${user}"}';set role authenticated;`;
 const replay=JSON.parse(sql(auth+`select public.sg_cloud_save('save','progress','${JSON.stringify({...oldRequest,generation:'1'})}');`));
 assert.equal(replay.save.revision,1);assert.equal(replay.generation,'1');
 const live=JSON.parse(sql(auth+"select public.sg_cloud_save('load','progress');"));assert.deepEqual(live.save.data,{level:2});assert.equal(live.save.revision,2);
 const restored=JSON.parse(sql(auth+`select public.sg_cloud_save('restore','progress','{"generation":"1","operationId":"da000000-0000-4000-8000-000000000003","expectedRevision":2,"revision":1}');`));assert.equal(restored.save.revision,3);
 assert.equal(sql("select count(*) from pg_index where indrelid='sg_private.game_submission_events'::regclass and indexrelid='sg_private.admin_history'::regclass"),'1');
});

begin;
-- Existing lifecycle scenarios use freshly observed context for new intents.
-- Explicit stale/replay semantics are covered in cloud-saves-generations.test.sql.
create function pg_temp.sg_save(a text,s text default null,r jsonb default '{}') returns jsonb language plpgsql as $$
declare g text;
begin
 if a in ('save','delete','prepare','commit','abort','restore') then
  g:=public.sg_cloud_save('list',null,'{}')->>'generation';
  r:=r||jsonb_build_object('generation',g);
 end if;
 return public.sg_cloud_save(a,s,r);
end;$$;

create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values ('c1000000-0000-4000-8000-000000000001',true),('c1000000-0000-4000-8000-000000000002',true);
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","is_anonymous":true}';
set local role authenticated;
select is(pg_temp.sg_save('prepare','rpg','{"operationId":"d1000000-0000-4000-8000-000000000001","expectedRevision":0,"schemaVersion":1,"metadata":{},"sizeBytes":8,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')->'upload'->>'path','c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','server scopes immutable path');
select throws_ok($$select pg_temp.sg_save('commit','rpg','{"operationId":"d1000000-0000-4000-8000-000000000001"}')$$,'P0001','STORAGE_UNAVAILABLE','missing object cannot commit');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('supagame-saves','arbitrary','{"size":8}')$$,'42501',null,'unreserved uploads denied');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('supagame-saves','c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','{"size":9}')$$,'42501',null,'reservation size is enforced on upload, before commit');
insert into storage.objects(bucket_id,name,metadata) values('supagame-saves','c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','{"size":8}');
select is(pg_temp.sg_save('commit','rpg','{"operationId":"d1000000-0000-4000-8000-000000000001"}')->'save'->>'revision','1','metadata commit after upload');
select is(pg_temp.sg_save('commit','rpg','{"operationId":"d1000000-0000-4000-8000-000000000001"}')->'save'->>'revision','1','lost commit response retry idempotent');
with changed as (update storage.objects set name='changed' where bucket_id='supagame-saves' returning 1) select is(count(*),0::bigint,'live object cannot be overwritten') from changed;
select is(public.sg_save_object_access('c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','delete'),false,'live object cannot be deleted');
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000002"}';
select is((select count(*) from storage.objects where bucket_id='supagame-saves'),0::bigint,'other player cannot read binary');
select is(public.sg_save_object_access('c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','insert'),false,'other player cannot upload');
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001"}';
select pg_temp.sg_save('prepare','rpg','{"operationId":"d1000000-0000-4000-8000-000000000002","expectedRevision":1,"schemaVersion":2,"metadata":{},"sizeBytes":8,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
insert into storage.objects(bucket_id,name,metadata) values('supagame-saves','c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000002','{"size":7}');
select throws_ok($$select pg_temp.sg_save('commit','rpg','{"operationId":"d1000000-0000-4000-8000-000000000002"}')$$,'22023','INVALID_SAVE','wrong object size cannot commit');
select is(pg_temp.sg_save('load','rpg','{}')->'save'->>'revision','1','failed replacement preserves last valid save');
select pg_temp.sg_save('abort','rpg','{"operationId":"d1000000-0000-4000-8000-000000000002"}');
select is(jsonb_array_length(pg_temp.sg_save('cleanup',null,'{}')->'objects'),1,'aborted upload becomes recoverable garbage');
select throws_ok($$select pg_temp.sg_save('commit','rpg','{"operationId":"d1000000-0000-4000-8000-000000000002"}')$$,'22023','INVALID_SAVE','aborted upload cannot resurrect');
select pg_temp.sg_save('delete','rpg','{"operationId":"d1000000-0000-4000-8000-000000000003","expectedRevision":1}');
select is(public.sg_save_object_access('c1000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001','delete'),true,'retired object may be deleted after metadata commit');
reset role;
select is((select public from storage.buckets where id='supagame-saves'),false,'bucket private');
-- Host applications may have permissive policies. Restrictive namespace guards
-- still protect this bucket without removing unrelated host policies.
create policy test_broad_storage_read on storage.objects for select to authenticated using(true);
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000002"}';
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id='supagame-saves'),0::bigint,'broad host policy cannot bypass owner guard');
reset role;
select * from finish();
rollback;

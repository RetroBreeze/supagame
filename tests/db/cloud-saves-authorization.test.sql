begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values
 ('c3000000-0000-4000-8000-000000000001',true),
 ('c3000000-0000-4000-8000-000000000002',true);
insert into sg_private.save_objects values
 ('c3000000-0000-4000-8000-000000000001/orphan','c3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','slot','{}','pending',8,now());
delete from auth.users where id='c3000000-0000-4000-8000-000000000001';
set local request.jwt.claims='{"sub":"c3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.sg_cloud_save('prepare','slot','{"operationId":"d3000000-0000-4000-8000-000000000002","expectedRevision":0,"schemaVersion":1,"metadata":{},"sizeBytes":8,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,'28000','UNAUTHORIZED','deleted identity cannot reserve an upload');
select throws_ok($$select public.sg_cloud_save('list',null,'{}')$$,'28000','UNAUTHORIZED','deleted identity cannot use read RPCs');
select throws_ok(format('select public.sg_cloud_save(%L,%L,%L::jsonb)',action,'slot','{}'),'28000','UNAUTHORIZED','deleted identity rejected for '||action) from unnest(array['save','delete','commit','abort','restore','revisions','loadRevision','cleanup'])action;
select is(public.sg_save_object_access('c3000000-0000-4000-8000-000000000001/orphan','insert'),false,'deleted identity cannot upload to orphan');
select is(public.sg_save_object_access('c3000000-0000-4000-8000-000000000001/orphan','read'),false,'deleted identity cannot read orphan');
select is(public.sg_save_upload_size('c3000000-0000-4000-8000-000000000001/orphan','8'),false,'upload size helper also fails closed');
reset role;
update sg_private.save_objects set state='garbage' where path='c3000000-0000-4000-8000-000000000001/orphan';
set local role authenticated;
select is(public.sg_save_object_access('c3000000-0000-4000-8000-000000000001/orphan','delete'),false,'deleted identity cannot delete orphan');
reset role;
select is((select count(*) from sg_private.save_objects where path='c3000000-0000-4000-8000-000000000001/orphan'),1::bigint,'orphan registry survives deletion for operator cleanup');
insert into public.game_saves(user_id,slot,revision,data) values('c3000000-0000-4000-8000-000000000002','private',1,'{"secret":true}');
update auth.users set deleted_at=now() where id='c3000000-0000-4000-8000-000000000002';
set local request.jwt.claims='{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select public.sg_cloud_save('list',null,'{}')$$,'28000','UNAUTHORIZED','soft-deleted identity cannot use Cloud Saves');
select is((select count(*) from public.game_saves),0::bigint,'soft-deleted identity cannot bypass RPC through table SELECT');
reset role;
select * from finish();
rollback;

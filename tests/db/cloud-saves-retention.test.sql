begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values('c5000000-0000-4000-8000-000000000001',true);
set local request.jwt.claims='{"sub":"c5000000-0000-4000-8000-000000000001"}';
-- Representative pre-upgrade history: the migration must not discard live data.
insert into sg_private.save_operations(user_id,operation_id,fingerprint,result,created_at)
select auth.uid(),('d5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'old',jsonb_build_object('save',jsonb_build_object('slot','old','revision',n)),now()-interval '2 minutes'+n*interval '1 microsecond' from generate_series(1,4096)n;
insert into public.game_saves(user_id,slot,revision,deleted) select auth.uid(),'old-'||n,2,true from generate_series(1,1100)n;
create temporary table observed(generation text);
insert into observed select public.sg_cloud_save('list',null,'{}')->>'generation';
select ok((select generation is not null from observed),'context exposes a durable generation');
select public.sg_cloud_save('save','live',jsonb_build_object('operationId','d5000000-0000-4000-8000-000000009999','expectedRevision',0,'schemaVersion',1,'metadata','{}'::jsonb,'data','{}'::jsonb)||case when (select generation from observed) is null then '{}'::jsonb else jsonb_build_object('generation',(select generation from observed)) end);
select ok((select count(*)<=4096 from sg_private.save_operations where user_id=auth.uid()),'completed receipts remain bounded');
select ok((select count(*)<=1024 from public.game_saves where user_id=auth.uid() and deleted),'unbacked tombstones remain bounded');
select is((select count(*) from sg_private.save_operations where user_id=auth.uid() and operation_id>='d5000000-0000-4000-8000-000000001025' and operation_id<='d5000000-0000-4000-8000-000000004096'),3072::bigint,'latest 3072 eligible legacy receipts survive pruning');
insert into auth.users(id,is_anonymous) values('c8000000-0000-4000-8000-000000000001',true);
set local request.jwt.claims='{"sub":"c8000000-0000-4000-8000-000000000001"}';
insert into sg_private.save_objects(path,user_id,operation_id,slot,request,state,size_bytes)
select auth.uid()::text||'/'||op,auth.uid(),op::uuid,'old','{}','garbage',1 from
(select 'd8000000-0000-4000-8000-'||lpad(n::text,12,'0') op from generate_series(1,4096)n)x;
select public.sg_cloud_save('list');
set local role authenticated;
select throws_ok($$select public.sg_cloud_save('prepare','new','{"generation":"1","operationId":"d8000000-0000-4000-8000-000000009999","expectedRevision":0,"schemaVersion":1,"metadata":{},"sizeBytes":1,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,'54000','SAVE_QUOTA_EXCEEDED','registry cap counts garbage metadata independently of byte quota');
select is(public.sg_cloud_save('cleanup',null,'{}')->>'generation','2','registry cleanup advances generation before forgetting IDs');
reset role;
select is((select count(*) from sg_private.save_objects where user_id=auth.uid()),3996::bigint,'cleanup removes at most 100 absent objects');
set local role authenticated;
select lives_ok($$select public.sg_cloud_save('prepare','new','{"generation":"2","operationId":"d8000000-0000-4000-8000-000000009999","expectedRevision":0,"schemaVersion":1,"metadata":{},"sizeBytes":1,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,'explicit new context can reserve after bounded cleanup');
reset role;
select * from finish();rollback;

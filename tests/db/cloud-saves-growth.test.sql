begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values('c7000000-0000-4000-8000-000000000001',true);
set local request.jwt.claims='{"sub":"c7000000-0000-4000-8000-000000000001"}';
create temporary table retained_requests(n integer primary key,payload jsonb);
-- Advance the rate fixture every 50 operations without waiting real minutes.
-- Rate boundaries and races are tested separately against the actual counters.
do $$declare g text;r jsonb;result jsonb;begin
 for i in 1..5000 loop
  if i%50=1 then update sg_private.save_state set mutation_times='{}' where user_id=auth.uid();end if;
  g:=public.sg_cloud_save('list',null,'{}')->>'generation';
  r:=jsonb_build_object('generation',g,'operationId',gen_random_uuid(),'expectedRevision',i-1,'schemaVersion',1,'metadata','{}'::jsonb,'data',jsonb_build_object('n',i));
  result:=public.sg_cloud_save('save','progress',r);
  if (result->'save'->>'revision')::integer is distinct from i then raise exception 'unexpected write result: %',result;end if;
  if i in (1,4999) then insert into retained_requests values(i,r);end if;
 end loop;
 for i in 1..1200 loop
  if i%20=1 then update sg_private.save_state set mutation_times='{}' where user_id=auth.uid();end if;
  g:=public.sg_cloud_save('list',null,'{}')->>'generation';
  result:=public.sg_cloud_save('save','cycle-'||i,jsonb_build_object('generation',g,'operationId',gen_random_uuid(),'expectedRevision',0,'schemaVersion',1,'metadata','{}'::jsonb,'data','{}'::jsonb));
  if result->'save'->>'revision' is distinct from '1' then raise exception 'create failed';end if;
  g:=public.sg_cloud_save('list',null,'{}')->>'generation';
  result:=public.sg_cloud_save('delete','cycle-'||i,jsonb_build_object('generation',g,'operationId',gen_random_uuid(),'expectedRevision',1));
  if result->'save'->>'deleted' is distinct from 'true' then raise exception 'delete failed';end if;
 end loop;
end;$$;
select ok((select count(*)<=4096 from sg_private.save_operations where user_id=auth.uid()),'7400 sequential mutations keep receipts bounded');
select ok((select count(*)<=1024 from public.game_saves where user_id=auth.uid() and deleted),'1200 distinct deleted names keep tombstones bounded');
select ok((select sum(pg_column_size(result))<=4096*8192 from sg_private.save_operations where user_id=auth.uid()),'actual retained receipt payload bytes respect the documented bound');
select is(public.sg_cloud_save('save','progress',(select payload from retained_requests where n=4999))->'save'->>'revision','4999','covered replay survives many tombstone generation changes');
select is(public.sg_cloud_save('save','progress',(select payload from retained_requests where n=1))->>'code','SAVE_CONFLICT','forgotten old operation cannot execute again');
select is(public.sg_cloud_save('load','progress','{}')->'save'->'data','{"n":5000}'::jsonb,'replays and maintenance preserve the current live save');
select diag((select jsonb_build_object('receipts',count(*),'receiptBytes',sum(pg_column_size(result)))::text from sg_private.save_operations where user_id=auth.uid()));
select * from finish();rollback;

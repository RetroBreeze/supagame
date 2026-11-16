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
insert into auth.users(id,is_anonymous) values('c2000000-0000-4000-8000-000000000001',true);
set local role authenticated;
set local request.jwt.claims='{"sub":"c2000000-0000-4000-8000-000000000001"}';
select pg_temp.sg_save('save','profile','{"operationId":"d2000000-0000-4000-8000-000000000001","expectedRevision":0,"schemaVersion":1,"metadata":{},"data":{}}');
do $$ begin for i in 1..59 loop perform pg_temp.sg_save('save','profile',jsonb_build_object('operationId',gen_random_uuid(),'expectedRevision',i,'schemaVersion',1,'metadata','{}'::jsonb,'data','{}'::jsonb)); end loop; end $$;
select throws_ok($$select pg_temp.sg_save('save','profile',jsonb_build_object('operationId',gen_random_uuid(),'expectedRevision',60,'schemaVersion',1,'metadata','{}'::jsonb,'data','{}'::jsonb))$$,'P0001','RATE_LIMITED','61st new write in a minute rejected');
select is(pg_temp.sg_save('save','profile','{"operationId":"d2000000-0000-4000-8000-000000000001","expectedRevision":0,"schemaVersion":1,"metadata":{},"data":{}}')->'save'->>'revision','1','receipt replay remains free at rate limit');
reset role;
select * from finish();rollback;

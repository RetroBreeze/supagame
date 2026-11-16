begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values('c4000000-0000-4000-8000-000000000001',true);
update sg_private.save_config set max_pending=100;
set local request.jwt.claims='{"sub":"c4000000-0000-4000-8000-000000000001"}';
create function pg_temp.save(action text, request jsonb) returns jsonb language plpgsql as $$
declare g text;
begin
 g:=public.sg_cloud_save('list',null,'{}')->>'generation';
 return public.sg_cloud_save(action,'upload',request||case when g is null then '{}'::jsonb else jsonb_build_object('generation',g) end);
end;$$;
create function pg_temp.prepare(n integer) returns jsonb language sql as $$
 select pg_temp.save('prepare',jsonb_build_object('operationId','d4000000-0000-4000-8000-'||lpad(n::text,12,'0'),'expectedRevision',0,'schemaVersion',1,'metadata','{}'::jsonb,'sizeBytes',8,'checksum',repeat('a',64)));
$$;
set local role authenticated;
do $$begin for i in 1..60 loop perform pg_temp.prepare(i); end loop; end$$;
select throws_ok($$select pg_temp.prepare(61)$$,'P0001','RATE_LIMITED','61st reservation is throttled');
select is(pg_temp.prepare(1)->'upload'->>'operationId','d4000000-0000-4000-8000-000000000001','exact prepare retry is free at limit');
do $$begin for i in 1..60 loop perform pg_temp.save('abort',jsonb_build_object('operationId','d4000000-0000-4000-8000-'||lpad(i::text,12,'0'))); end loop; end$$;
select lives_ok($$select pg_temp.save('abort','{"operationId":"d4000000-0000-4000-8000-000000000001"}')$$,'repeated abort is free');
select lives_ok($$select public.sg_cloud_save('cleanup',null,'{}')$$,'cleanup remains available at rate limit');
select throws_ok($$select pg_temp.prepare(62)$$,'P0001','RATE_LIMITED','cleanup cannot erase reservation rate state');
reset role;
-- Trusted fixture seeds one additional pending object without consuming prepare
-- allowance, so the abort category is exercised independently at its boundary.
insert into sg_private.save_objects(path,user_id,operation_id,slot,request,state,size_bytes)
values(auth.uid()::text||'/extra',auth.uid(),'d4000000-0000-4000-8000-000000000099','upload','{}','pending',8);
set local role authenticated;
select throws_ok($$select pg_temp.save('abort','{"operationId":"d4000000-0000-4000-8000-000000000099"}')$$,'P0001','RATE_LIMITED','61st state-changing abort is throttled');
reset role;
select is((select state from sg_private.save_objects where operation_id='d4000000-0000-4000-8000-000000000099'),'pending','rate rejection leaves reservation recoverable');
update sg_private.save_state set reservation_times=array_fill(clock_timestamp()-interval '60 seconds',array[60]),abort_times=array_fill(clock_timestamp()-interval '60 seconds',array[60]) where user_id=auth.uid();
set local role authenticated;
select lives_ok($$select pg_temp.save('abort','{"operationId":"d4000000-0000-4000-8000-000000000099"}')$$,'interrupted abort retries after rolling window expires');
select lives_ok($$select pg_temp.prepare(62)$$,'reservation retries after rolling window expires');
reset role;
select is(cardinality(reservation_times),1,'expired timestamps do not accumulate') from sg_private.save_state where user_id=auth.uid();
select * from finish();rollback;

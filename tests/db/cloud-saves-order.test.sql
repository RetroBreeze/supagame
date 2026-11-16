begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,is_anonymous) values('c7000000-0000-4000-8000-000000000001',true);
set local request.jwt.claims='{"sub":"c7000000-0000-4000-8000-000000000001"}';
select public.sg_cloud_save('list');
-- Completion order must remain durable when the wall clock moves backwards.
insert into sg_private.save_operations(user_id,operation_id,fingerprint,result,created_at)
select auth.uid(),('d7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'old','{}',clock_timestamp()
from generate_series(1,4095)n;
insert into sg_private.save_operations(user_id,operation_id,fingerprint,result,created_at)
values(auth.uid(),'d7000000-0000-4000-8000-000000004096','latest','{}',clock_timestamp()-interval '1 day');
select public.sg_cloud_save('list');
select ok(exists(select 1 from sg_private.save_operations where user_id=auth.uid() and operation_id='d7000000-0000-4000-8000-000000004096'),'latest completion survives a backwards wall clock within its age window');
select is((select count(*) from sg_private.save_operations where user_id=auth.uid()),3072::bigint,'retention preserves the latest 3072 completions');
select * from finish();
rollback;

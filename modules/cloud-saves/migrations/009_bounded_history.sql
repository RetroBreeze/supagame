-- Generation fencing permits bounded history without making obsolete creates new.
-- No live save, backup, receipt or tombstone is deleted by this schema migration.
create table sg_private.save_state (
 user_id uuid primary key references auth.users(id) on delete cascade,
 generation bigint not null default 1 check(generation>0),
 mutation_times timestamptz[] not null default '{}',
 reservation_times timestamptz[] not null default '{}',
 abort_times timestamptz[] not null default '{}',
 check(cardinality(mutation_times)<=60 and cardinality(reservation_times)<=60 and cardinality(abort_times)<=60)
);
alter table sg_private.save_state enable row level security;
revoke all on sg_private.save_state from public,anon,authenticated,service_role;
alter table sg_private.save_operations add column action text;
alter table sg_private.save_operations add column slot text;
alter table sg_private.save_operations add constraint save_receipt_metadata_bound check(octet_length(result::text)<=8192) not valid;
alter table sg_private.save_objects add constraint save_reservation_metadata_bound check(octet_length(request::text)<=8192) not valid;
create index save_receipts_retention on sg_private.save_operations(user_id,created_at desc,operation_id);
create index save_tombstone_retention on public.game_saves(user_id,updated_at,slot) where deleted;

-- All helpers below require the public RPC/operator's per-user advisory lock.
create function sg_private.advance_save_generation(u uuid) returns void
language sql set search_path='' as $$
 update sg_private.save_state set generation=generation+1 where user_id=u;
$$;
revoke all on function sg_private.advance_save_generation(uuid) from public,anon,authenticated,service_role;

create function sg_private.maintain_save_history(u uuid) returns void
language plpgsql set search_path='' as $$
declare receipts uuid[]; tombstones text[]; over_capacity boolean;
begin
 perform sg_private.prune_save_revisions(u);
 select count(*)>=4096 into over_capacity from sg_private.save_operations where user_id=u;
 select array_agg(operation_id) into receipts from (
  select operation_id from sg_private.save_operations
  where user_id=u and (created_at<=clock_timestamp()-interval '30 days' or
   (over_capacity and operation_id not in (select operation_id from sg_private.save_operations where user_id=u order by created_at desc,operation_id desc limit 3072)))
  order by created_at,operation_id limit 1024
 ) candidates;
 select array_agg(slot) into tombstones from (
  select s.slot from public.game_saves s where s.user_id=u and s.deleted
   and not exists(select 1 from sg_private.save_revisions r where r.user_id=u and r.slot=s.slot)
   and (s.updated_at<=clock_timestamp()-interval '30 days' or s.slot not in (
    select t.slot from public.game_saves t where t.user_id=u and t.deleted
    and not exists(select 1 from sg_private.save_revisions r where r.user_id=u and r.slot=t.slot)
    order by t.updated_at desc,t.slot desc limit 1024))
  order by s.updated_at,s.slot limit 256
 ) candidates;
 if cardinality(receipts)>0 or cardinality(tombstones)>0 then
  perform sg_private.advance_save_generation(u);
  delete from sg_private.save_operations where user_id=u and operation_id=any(receipts);
  delete from public.game_saves where user_id=u and slot=any(tombstones);
 end if;
end;
$$;
revoke all on function sg_private.maintain_save_history(uuid) from public,anon,authenticated,service_role;

create function sg_private.consume_save_rate(u uuid, category text) returns void
language plpgsql set search_path='' as $$
declare stamps timestamptz[]; at_time timestamptz:=clock_timestamp();
begin
 select case category when 'mutation' then mutation_times when 'reservation' then reservation_times when 'abort' then abort_times end
 into stamps from sg_private.save_state where user_id=u;
 if stamps is null then raise exception 'Invalid save rate category or missing state'; end if;
 select coalesce(array_agg(t),'{}') into stamps from unnest(stamps)t where t>at_time-interval '60 seconds';
 if cardinality(stamps)>=60 then raise exception using errcode='P0001',message='RATE_LIMITED'; end if;
 stamps:=array_append(stamps,at_time);
 update sg_private.save_state set
 mutation_times=case when category='mutation' then stamps else mutation_times end,
 reservation_times=case when category='reservation' then stamps else reservation_times end,
 abort_times=case when category='abort' then stamps else abort_times end where user_id=u;
end;
$$;
revoke all on function sg_private.consume_save_rate(uuid,text) from public,anon,authenticated,service_role;

create or replace function sg_private.save_record(s public.game_saves, include_data boolean default true) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('slot',s.slot,'revision',s.revision,'schemaVersion',s.schema_version,
 'kind',s.kind,'metadata',s.metadata,'sizeBytes',s.size_bytes,'deleted',s.deleted,
 'createdAt',s.created_at,'updatedAt',s.updated_at,'objectPath',s.object_path,'generation',coalesce((select generation::text from sg_private.save_state where user_id=s.user_id),'1'))
 || case when include_data and s.kind='json' then jsonb_build_object('data',s.data) else '{}'::jsonb end;
$$;
revoke all on function sg_private.save_record(public.game_saves,boolean) from public,anon,authenticated,service_role;

create or replace function public.sg_cloud_save(p_action text,p_slot text default null,p_request jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid := auth.uid(); s public.game_saves; cfg sg_private.save_config;
 op uuid; expected bigint; fingerprint text; receipt sg_private.save_operations;
 obj sg_private.save_objects; n bigint; bytes bigint; result jsonb; object_key text;
 g text; supplied_generation text; removed integer;
 allowed text[]; actual_size bigint; backup boolean; saved public.game_saves;
begin
 if not sg_private.lock_save_identity() then raise exception using errcode='28000',message='UNAUTHORIZED'; end if;
 if p_action is null or p_action not in ('list','load','save','delete','prepare','commit','abort','cleanup','revisions','loadRevision','restore') or jsonb_typeof(p_request) is distinct from 'object' then
  raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 if pg_catalog.current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 -- Per-player serialization covers quotas, revisions, idempotency and cleanup.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:saves:'||u::text,0));
 insert into sg_private.save_state(user_id) values(u) on conflict do nothing;
 select * into cfg from sg_private.save_config;
 perform sg_private.maintain_save_history(u);
 select generation::text into g from sg_private.save_state where user_id=u;
 if p_action='list' then
  return jsonb_build_object('generation',g,'slots',coalesce((select jsonb_agg(sg_private.save_record(t,false) order by slot) from public.game_saves t where user_id=u and not deleted),'[]'::jsonb));
 end if;
 if p_action='cleanup' then
  if p_request<>'{}'::jsonb then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  update sg_private.save_objects set state='garbage' where user_id=u and state='pending' and created_at<now()-interval '24 hours';
  -- Only remove registry rows after Storage has removed the physical object.
  select count(*) into removed from sg_private.save_objects o where user_id=u and state='garbage' and not exists(select 1 from storage.objects so where so.bucket_id='supagame-saves' and so.name=o.path);
  if removed>0 then
   perform sg_private.advance_save_generation(u);
   delete from sg_private.save_objects where path in (select o.path from sg_private.save_objects o where user_id=u and state='garbage' and not exists(select 1 from storage.objects so where so.bucket_id='supagame-saves' and so.name=o.path) order by path limit 100);
   select generation::text into g from sg_private.save_state where user_id=u;
  end if;
  return jsonb_build_object('generation',g,'objects',coalesce((select jsonb_agg(o.path) from (select path from sg_private.save_objects where user_id=u and state='garbage' order by created_at limit 100) o),'[]'::jsonb));
 end if;
 if p_slot is null or p_slot !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 select * into s from public.game_saves where user_id=u and slot=p_slot;
 if p_action='load' then
  if s.user_id is null or s.deleted then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
  return jsonb_build_object('generation',g,'save',sg_private.save_record(s));
 end if;
 if p_action='revisions' then
  if p_request<>'{}'::jsonb then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  return jsonb_build_object('generation',g,'revisions',coalesce((select jsonb_agg(jsonb_build_object(
   'save',sg_private.save_record(r.snapshot,false),'archivedAt',r.archived_at,'expiresAt',r.expires_at) order by r.revision desc)
   from sg_private.save_revisions r where r.user_id=u and r.slot=p_slot),'[]'::jsonb));
 end if;
 if p_action in ('loadRevision','restore') then
  if jsonb_typeof(p_request->'revision') is distinct from 'number' or coalesce(p_request->>'revision','') !~ '^[0-9]{1,16}$'
   or (p_request->>'revision')::numeric not between 1 and 9007199254740991 then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  if p_action='loadRevision' then
   if p_request-'revision'<>'{}'::jsonb then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   select (r.snapshot).* into saved from sg_private.save_revisions r where r.user_id=u and r.slot=p_slot and r.revision=(p_request->>'revision')::bigint;
   if saved.user_id is null then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
   return jsonb_build_object('generation',g,'save',sg_private.save_record(saved));
  end if;
 end if;
 allowed:=case when p_action='restore' then array['operationId','expectedRevision','revision'] when p_action in ('commit','abort') then array['operationId'] when p_action='delete' then array['operationId','expectedRevision'] when p_action='save' then array['operationId','expectedRevision','schemaVersion','data','metadata'] else array['operationId','expectedRevision','schemaVersion','sizeBytes','metadata','checksum'] end;
 allowed:=allowed||array['generation'];
 if p_action in ('save','delete','prepare') and p_request ? 'backupExisting' then
  if jsonb_typeof(p_request->'backupExisting') is distinct from 'boolean' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  allowed:=allowed||array['backupExisting'];
 end if;
 if (select count(*) from jsonb_object_keys(p_request))<>cardinality(allowed) or not p_request ?& allowed then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 if coalesce(p_request->>'operationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 op:=(p_request->>'operationId')::uuid;
 if jsonb_typeof(p_request->'generation') is distinct from 'string' or (p_request->>'generation') !~ '^[1-9][0-9]{0,18}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 supplied_generation:=p_request->>'generation';
 -- Completed binary retries survive registry GC and generation changes.
 if p_action='commit' then
  select * into receipt from sg_private.save_operations where user_id=u and operation_id=op;
  if receipt.user_id is not null and receipt.action='binary' and receipt.slot=p_slot and receipt.created_at>clock_timestamp()-interval '30 days' then return receipt.result; end if;
 end if;
 if p_action in ('commit','abort') then
  select * into obj from sg_private.save_objects where user_id=u and operation_id=op and slot=p_slot;
  if obj.path is null then
   if supplied_generation<>g then return jsonb_build_object('generation',g,'code','SAVE_CONFLICT','message','Save history changed. Reconcile the local copy explicitly.','current',case when s.user_id is null then 'null'::jsonb else sg_private.save_record(s) end); end if;
   raise exception using errcode='P0002',message='SAVE_NOT_FOUND';
  end if;
  if p_action='abort' then
   if obj.state='live' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   if obj.state<>'garbage' then perform sg_private.consume_save_rate(u,'abort'); end if;
   update sg_private.save_objects set state='garbage' where path=obj.path;
   return jsonb_build_object('generation',g,'objects',jsonb_build_array(obj.path));
  end if;
  p_request:=obj.request;
 end if;
 if coalesce(p_request->>'expectedRevision','') !~ '^[0-9]{1,16}$' or (p_request->>'expectedRevision')::numeric>9007199254740991 then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 expected:=(p_request->>'expectedRevision')::bigint;
 fingerprint:=encode(extensions.digest(p_slot||':'||case when p_action in ('prepare','commit') then 'binary' else p_action end||':'||(p_request-'generation')::text,'sha256'),'hex');
 select * into receipt from sg_private.save_operations where user_id=u and operation_id=op;
 if receipt.user_id is not null then
  if receipt.fingerprint<>fingerprint then raise exception using errcode='23505',message='DUPLICATE_KEY_CONFLICT'; end if;
  if receipt.created_at<=clock_timestamp()-interval '30 days' then return jsonb_build_object('generation',g,'code','SAVE_CONFLICT','message','Replay history expired. Reconcile the local copy explicitly.','current',case when s.user_id is null then 'null'::jsonb else sg_private.save_record(s) end); end if;
  return jsonb_set(receipt.result,'{save,generation}',to_jsonb(coalesce(receipt.result->'save'->>'generation','1')))||jsonb_build_object('generation',coalesce(receipt.result->>'generation','1'));
 end if;
 if supplied_generation<>g or (p_request->>'generation') is distinct from g
 or (select count(*) from sg_private.save_operations where user_id=u)>=4096 then
  -- Commit is never re-based onto a generation newer than its preparation.
  if p_action='commit' and obj.state='pending' then update sg_private.save_objects set state='garbage' where path=obj.path; end if;
  return jsonb_build_object('generation',g,'code','SAVE_CONFLICT','message','Save history changed. Reconcile the local copy explicitly.','current',case when s.user_id is null then 'null'::jsonb else sg_private.save_record(s) end);
 end if;
 -- Reserve IDs cannot be reused as JSON/delete operations either.
 if exists(select 1 from sg_private.save_objects where user_id=u and operation_id=op and (request<>p_request or slot<>p_slot or p_action not in ('prepare','commit'))) then raise exception using errcode='23505',message='DUPLICATE_KEY_CONFLICT'; end if;
 if p_action='prepare' then
  select * into obj from sg_private.save_objects where user_id=u and operation_id=op;
  if obj.path is not null and obj.state='pending' and obj.created_at>clock_timestamp()-interval '24 hours' then
   return jsonb_build_object('generation',g,'upload',jsonb_build_object('bucket','supagame-saves','path',obj.path,'operationId',op));
  end if;
 end if;
 if expected<>coalesce(s.revision,0) then
  return jsonb_build_object('generation',g,'code','SAVE_CONFLICT','message','The save revision changed. Keep both copies and resolve explicitly.','current',case when s.user_id is null then 'null'::jsonb else sg_private.save_record(s) end);
 end if;
 backup:=p_action='restore' or coalesce((p_request->>'backupExisting')::boolean,false);
 if p_action='restore' then
  select (r.snapshot).* into saved from sg_private.save_revisions r where r.user_id=u and r.slot=p_slot and r.revision=(p_request->>'revision')::bigint;
  if saved.user_id is null then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
 end if;
 -- Bound history metadata too, including histories of deleted slots. The
 -- existing slot limit independently caps live slots and slots with backups.
 if backup and s.user_id is not null and not s.deleted
  and not exists(select 1 from sg_private.save_revisions where user_id=u and slot=p_slot)
  and (select count(distinct slot) from sg_private.save_revisions where user_id=u)>=cfg.max_slots then
  raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
 if p_action='delete' and (s.user_id is null or s.deleted) then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
 if p_action not in ('delete','restore') then
  if coalesce(p_request->>'schemaVersion','') !~ '^[0-9]{1,10}$' or (p_request->>'schemaVersion')::numeric not between 1 and 2147483647 or jsonb_typeof(p_request->'metadata') is distinct from 'object' or octet_length((p_request->'metadata')::text)>4096 then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  if p_action='save' then
   bytes:=octet_length((p_request->'data')::text);
   if bytes>cfg.max_json_bytes then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  else
   if coalesce(p_request->>'checksum','') !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   if coalesce(p_request->>'sizeBytes','') !~ '^[0-9]{1,13}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   bytes:=(p_request->>'sizeBytes')::bigint;
   if bytes<1 or bytes>cfg.max_binary_bytes then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  end if;
  select count(*) into n from public.game_saves where user_id=u and not deleted and slot<>p_slot;
  if n>=cfg.max_slots then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  -- Include pending/retired binary objects until cleanup, bounding incomplete uploads.
  select coalesce(sum(size_bytes),0) into n from public.game_saves where user_id=u and not deleted and kind='json' and slot<>p_slot;
  n:=n+coalesce((select sum(size_bytes) from sg_private.save_objects where user_id=u and operation_id<>op),0);
  n:=n+coalesce((select sum((r.snapshot).size_bytes) from sg_private.save_revisions r where r.user_id=u and (r.snapshot).kind='json'
   and not (p_action<>'prepare' and backup and s.user_id is not null and not s.deleted and r.slot=p_slot
     and r.revision not in (select revision from sg_private.save_revisions where user_id=u and slot=p_slot order by revision desc limit 4))),0);
  if (backup or p_action='prepare') and s.user_id is not null and not s.deleted and s.kind='json' then n:=n+s.size_bytes; end if;
  if n+bytes>cfg.max_total_bytes then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
 end if;
 if p_action='prepare' then
  select * into obj from sg_private.save_objects where user_id=u and operation_id=op;
  if obj.path is not null then
   if obj.state<>'pending' or obj.created_at<=clock_timestamp()-interval '24 hours' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   return jsonb_build_object('generation',g,'upload',jsonb_build_object('bucket','supagame-saves','path',obj.path,'operationId',op));
  end if;
  if (select count(*) from sg_private.save_objects where user_id=u)>=4096 or (select count(*) from sg_private.save_objects where user_id=u and state='pending')>=cfg.max_pending then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  perform sg_private.consume_save_rate(u,'reservation');
  object_key:=u::text||'/'||op::text;
  insert into sg_private.save_objects values(object_key,u,op,p_slot,p_request,'pending',bytes,now());
  return jsonb_build_object('generation',g,'upload',jsonb_build_object('bucket','supagame-saves','path',object_key,'operationId',op));
 end if;
 if p_action='commit' then
  if obj.state<>'pending' or obj.created_at<clock_timestamp()-interval '24 hours' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  select (metadata->>'size')::bigint into actual_size from storage.objects where bucket_id='supagame-saves' and name=obj.path;
  if actual_size is null then raise exception using errcode='P0001',message='STORAGE_UNAVAILABLE'; end if;
  if actual_size<>bytes then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 end if;
 perform sg_private.consume_save_rate(u,'mutation');
 -- Archive only at the final commit, in the same transaction as replacement.
 -- If validation, quota or replacement fails, both archive and pruning roll back.
 if backup and s.user_id is not null and not s.deleted then
  insert into sg_private.save_revisions(user_id,slot,revision,snapshot) values(u,p_slot,s.revision,s)
   on conflict(user_id,slot,revision) do nothing;
  delete from sg_private.save_revisions r where r.user_id=u and r.slot=p_slot
   and r.revision not in (select revision from sg_private.save_revisions where user_id=u and slot=p_slot order by revision desc limit 5);
 end if;
 if p_action='restore' then
  if saved.kind='binary' and not exists(select 1 from storage.objects where bucket_id='supagame-saves' and name=saved.object_path and (metadata->>'size')::bigint=saved.size_bytes) then
   raise exception using errcode='P0001',message='STORAGE_UNAVAILABLE'; end if;
  if (select count(*) from public.game_saves where user_id=u and not deleted and slot<>p_slot)>=cfg.max_slots
   or (saved.kind='json' and saved.size_bytes>cfg.max_json_bytes)
   or (saved.kind='binary' and saved.size_bytes>cfg.max_binary_bytes) then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  update public.game_saves set revision=s.revision+1,schema_version=saved.schema_version,kind=saved.kind,data=saved.data,
   metadata=saved.metadata,object_path=saved.object_path,size_bytes=saved.size_bytes,deleted=false,updated_at=clock_timestamp()
   where user_id=u and slot=p_slot returning * into s;
  if s.user_id is null then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
  if saved.object_path is not null then update sg_private.save_objects set state='live' where path=saved.object_path; end if;
 else
 insert into public.game_saves as target(user_id,slot,revision,schema_version,kind,data,metadata,object_path,size_bytes,deleted)
 values(u,p_slot,coalesce(s.revision,0)+1,coalesce((p_request->>'schemaVersion')::integer,s.schema_version,1),case when p_action='commit' then 'binary' else 'json' end,
 case when p_action='save' then p_request->'data' else null end,coalesce(p_request->'metadata','{}'::jsonb),case when p_action='commit' then obj.path else null end,case when p_action='delete' then 0 else bytes end,p_action='delete')
 on conflict(user_id,slot) do update set revision=excluded.revision,schema_version=excluded.schema_version,kind=excluded.kind,data=excluded.data,metadata=excluded.metadata,object_path=excluded.object_path,size_bytes=excluded.size_bytes,deleted=excluded.deleted,updated_at=clock_timestamp()
 returning * into s;
 if p_action='commit' then update sg_private.save_objects set state='live' where path=obj.path; end if;
 end if;
 perform sg_private.prune_save_revisions(u);
 -- Authoritative final quota check includes retained JSON and every physical
 -- binary reservation (live, retained, pending or awaiting Storage cleanup).
 select coalesce(sum(size_bytes),0) into n from public.game_saves where user_id=u and not deleted and kind='json';
 n:=n+coalesce((select sum((snapshot).size_bytes) from sg_private.save_revisions where user_id=u and (snapshot).kind='json'),0)
     +coalesce((select sum(size_bytes) from sg_private.save_objects where user_id=u),0);
 if n>cfg.max_total_bytes and (p_action<>'delete' or backup) then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
 perform sg_private.maintain_save_history(u);
 select generation::text into g from sg_private.save_state where user_id=u;
 result:=jsonb_build_object('generation',g,'save',sg_private.save_record(s,false));
 insert into sg_private.save_operations(user_id,operation_id,fingerprint,result,action,slot,created_at) values(u,op,fingerprint,result,case when p_action='commit' then 'binary' else p_action end,p_slot,clock_timestamp());
 return result;
end;
$$;

-- Operator cleanup uses the same lock and fences forgotten reservation identities.
-- Deleted accounts have no state to advance and cannot authorize any operation.
create or replace function sg_private.finish_save_cleanup(p_paths text[]) returns integer
language plpgsql set search_path='' as $$
declare u uuid; victims text[]; removed integer:=0;
begin
 if cardinality(p_paths)>100 then raise exception 'Cleanup batches are limited to 100 objects'; end if;
 for u in select distinct user_id from sg_private.save_objects where path=any(p_paths) order by user_id loop
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:saves:'||u::text,0));
  select array_agg(o.path) into victims from sg_private.save_objects o where o.user_id=u and o.path=any(p_paths) and o.state='garbage'
   and not exists(select 1 from storage.objects so where so.bucket_id='supagame-saves' and so.name=o.path);
  if cardinality(victims)>0 then
   perform sg_private.advance_save_generation(u);
   delete from sg_private.save_objects where user_id=u and path=any(victims);
   removed:=removed+cardinality(victims);
  end if;
 end loop;
 return removed;
end;
$$;



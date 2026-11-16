-- Auth-row SHARE locks serialize hard deletion and soft-deletion updates against
-- save transactions and Storage policy checks. Session revocation remains JWT
-- expiry based; this check intentionally does not require session_id/custom JWTs.
create function sg_private.lock_save_identity() returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 perform 1 from auth.users where id=auth.uid() and deleted_at is null for share;
 return found;
end;
$$;
revoke all on function sg_private.lock_save_identity() from public,anon,authenticated,service_role;

create or replace function public.sg_cloud_save(p_action text,p_slot text default null,p_request jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid := auth.uid(); s public.game_saves; cfg sg_private.save_config;
 op uuid; expected bigint; fingerprint text; receipt sg_private.save_operations;
 obj sg_private.save_objects; n bigint; bytes bigint; result jsonb; object_key text;
 allowed text[]; actual_size bigint; backup boolean; saved public.game_saves;
begin
 if not sg_private.lock_save_identity() then raise exception using errcode='28000',message='UNAUTHORIZED'; end if;
 if p_action is null or p_action not in ('list','load','save','delete','prepare','commit','abort','cleanup','revisions','loadRevision','restore') or jsonb_typeof(p_request) is distinct from 'object' then
  raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 -- Per-player serialization covers quotas, revisions, idempotency and cleanup.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:saves:'||u::text,0));
 select * into cfg from sg_private.save_config;
 perform sg_private.prune_save_revisions(u);
 if p_action='list' then
  return jsonb_build_object('slots',coalesce((select jsonb_agg(sg_private.save_record(t,false) order by slot) from public.game_saves t where user_id=u and not deleted),'[]'::jsonb));
 end if;
 if p_action='cleanup' then
  if p_request<>'{}'::jsonb then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  update sg_private.save_objects set state='garbage' where user_id=u and state='pending' and created_at<now()-interval '24 hours';
  -- Only remove registry rows after Storage has removed the physical object.
  delete from sg_private.save_objects o where user_id=u and state='garbage' and not exists(select 1 from storage.objects so where so.bucket_id='supagame-saves' and so.name=o.path);
  return jsonb_build_object('objects',coalesce((select jsonb_agg(o.path) from (select path from sg_private.save_objects where user_id=u and state='garbage' order by created_at limit 100) o),'[]'::jsonb));
 end if;
 if p_slot is null or p_slot !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 select * into s from public.game_saves where user_id=u and slot=p_slot;
 if p_action='load' then
  if s.user_id is null or s.deleted then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
  return jsonb_build_object('save',sg_private.save_record(s));
 end if;
 if p_action='revisions' then
  if p_request<>'{}'::jsonb then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  return jsonb_build_object('revisions',coalesce((select jsonb_agg(jsonb_build_object(
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
   return jsonb_build_object('save',sg_private.save_record(saved));
  end if;
 end if;
 allowed:=case when p_action='restore' then array['operationId','expectedRevision','revision'] when p_action in ('commit','abort') then array['operationId'] when p_action='delete' then array['operationId','expectedRevision'] when p_action='save' then array['operationId','expectedRevision','schemaVersion','data','metadata'] else array['operationId','expectedRevision','schemaVersion','sizeBytes','metadata','checksum'] end;
 if p_action in ('save','delete','prepare') and p_request ? 'backupExisting' then
  if jsonb_typeof(p_request->'backupExisting') is distinct from 'boolean' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  allowed:=allowed||array['backupExisting'];
 end if;
 if (select count(*) from jsonb_object_keys(p_request))<>cardinality(allowed) or not p_request ?& allowed then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 if coalesce(p_request->>'operationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 op:=(p_request->>'operationId')::uuid;
 if p_action in ('commit','abort') then
  select * into obj from sg_private.save_objects where user_id=u and operation_id=op and slot=p_slot;
  if obj.path is null then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
  if p_action='abort' then
   if obj.state='live' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   update sg_private.save_objects set state='garbage' where path=obj.path;
   return jsonb_build_object('objects',jsonb_build_array(obj.path));
  end if;
  p_request:=obj.request;
 end if;
 if coalesce(p_request->>'expectedRevision','') !~ '^[0-9]{1,16}$' or (p_request->>'expectedRevision')::numeric>9007199254740991 then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 expected:=(p_request->>'expectedRevision')::bigint;
 fingerprint:=encode(extensions.digest(p_slot||':'||case when p_action in ('prepare','commit') then 'binary' else p_action end||':'||p_request::text,'sha256'),'hex');
 select * into receipt from sg_private.save_operations where user_id=u and operation_id=op;
 if receipt.user_id is not null then
  if receipt.fingerprint<>fingerprint then raise exception using errcode='23505',message='DUPLICATE_KEY_CONFLICT'; end if;
  return receipt.result;
 end if;
 if (select count(*) from sg_private.save_operations where user_id=u and created_at>now()-interval '60 seconds')>=60 then
  raise exception using errcode='P0001',message='RATE_LIMITED';
 end if;
 -- Reserve IDs cannot be reused as JSON/delete operations either.
 if exists(select 1 from sg_private.save_objects where user_id=u and operation_id=op and (request<>p_request or slot<>p_slot or p_action not in ('prepare','commit'))) then raise exception using errcode='23505',message='DUPLICATE_KEY_CONFLICT'; end if;
 if expected<>coalesce(s.revision,0) then
  return jsonb_build_object('code','SAVE_CONFLICT','message','The save revision changed. Keep both copies and resolve explicitly.','current',case when s.user_id is null then 'null'::jsonb else sg_private.save_record(s) end);
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
   if obj.state<>'pending' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
   return jsonb_build_object('upload',jsonb_build_object('bucket','supagame-saves','path',obj.path,'operationId',op));
  end if;
  if (select count(*) from sg_private.save_objects where user_id=u and state='pending')>=cfg.max_pending then raise exception using errcode='54000',message='SAVE_QUOTA_EXCEEDED'; end if;
  object_key:=u::text||'/'||op::text;
  insert into sg_private.save_objects values(object_key,u,op,p_slot,p_request,'pending',bytes,now());
  return jsonb_build_object('upload',jsonb_build_object('bucket','supagame-saves','path',object_key,'operationId',op));
 end if;
 if p_action='commit' then
  if obj.state<>'pending' or obj.created_at<now()-interval '24 hours' then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
  select (metadata->>'size')::bigint into actual_size from storage.objects where bucket_id='supagame-saves' and name=obj.path;
  if actual_size is null then raise exception using errcode='P0001',message='STORAGE_UNAVAILABLE'; end if;
  if actual_size<>bytes then raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 end if;
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
 result:=jsonb_build_object('save',sg_private.save_record(s,false));
 insert into sg_private.save_operations(user_id,operation_id,fingerprint,result) values(u,op,fingerprint,result);
 return result;
end;
$$;


create or replace function public.sg_save_object_access(p_name text,p_action text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 if not sg_private.lock_save_identity() then return false; end if;
 return exists(select 1 from sg_private.save_objects o where o.path=p_name and o.user_id=auth.uid()
 and case p_action when 'read' then true when 'insert' then o.state='pending' and o.created_at>clock_timestamp()-interval '24 hours'
 when 'delete' then o.state='garbage' else false end);
end;
$$;
create or replace function public.sg_save_upload_size(p_name text,p_size text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 if not sg_private.lock_save_identity() then return false; end if;
 return case when p_size ~ '^[0-9]{1,13}$' then exists(
 select 1 from sg_private.save_objects o where o.path=p_name and o.user_id=auth.uid()
 and o.state='pending' and o.created_at>clock_timestamp()-interval '24 hours'
 and p_size::bigint between 1 and o.size_bytes) else false end;
end;
$$;
-- CREATE OR REPLACE preserves the existing narrow EXECUTE grants.

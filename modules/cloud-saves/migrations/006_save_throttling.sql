-- Bound successful mutations per player. Replaying a committed operation is free.
create index save_operations_rate_idx on sg_private.save_operations(user_id,created_at);
create or replace function public.sg_cloud_save(p_action text,p_slot text default null,p_request jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid := auth.uid(); s public.game_saves; cfg sg_private.save_config;
 op uuid; expected bigint; fingerprint text; receipt sg_private.save_operations;
 obj sg_private.save_objects; n bigint; bytes bigint; result jsonb; object_key text;
 allowed text[]; actual_size bigint;
begin
 if u is null then raise exception using errcode='28000',message='UNAUTHORIZED'; end if;
 if p_action is null or p_action not in ('list','load','save','delete','prepare','commit','abort','cleanup') or jsonb_typeof(p_request) is distinct from 'object' then
  raise exception using errcode='22023',message='INVALID_SAVE'; end if;
 -- Per-player serialization covers quotas, revisions, idempotency and cleanup.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:saves:'||u::text,0));
 select * into cfg from sg_private.save_config;
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
 allowed:=case when p_action in ('commit','abort') then array['operationId'] when p_action='delete' then array['operationId','expectedRevision'] when p_action='save' then array['operationId','expectedRevision','schemaVersion','data','metadata'] else array['operationId','expectedRevision','schemaVersion','sizeBytes','metadata','checksum'] end;
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
 if p_action='delete' and (s.user_id is null or s.deleted) then raise exception using errcode='P0002',message='SAVE_NOT_FOUND'; end if;
 if p_action<>'delete' then
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
 if s.object_path is not null then update sg_private.save_objects set state='garbage' where path=s.object_path; end if;
 insert into public.game_saves as target(user_id,slot,revision,schema_version,kind,data,metadata,object_path,size_bytes,deleted)
 values(u,p_slot,coalesce(s.revision,0)+1,coalesce((p_request->>'schemaVersion')::integer,s.schema_version,1),case when p_action='commit' then 'binary' else 'json' end,
 case when p_action='save' then p_request->'data' else null end,coalesce(p_request->'metadata','{}'::jsonb),case when p_action='commit' then obj.path else null end,case when p_action='delete' then 0 else bytes end,p_action='delete')
 on conflict(user_id,slot) do update set revision=excluded.revision,schema_version=excluded.schema_version,kind=excluded.kind,data=excluded.data,metadata=excluded.metadata,object_path=excluded.object_path,size_bytes=excluded.size_bytes,deleted=excluded.deleted,updated_at=clock_timestamp()
 returning * into s;
 if p_action='commit' then update sg_private.save_objects set state='live' where path=obj.path; end if;
 result:=jsonb_build_object('save',sg_private.save_record(s,false));
 insert into sg_private.save_operations(user_id,operation_id,fingerprint,result) values(u,op,fingerprint,result);
 return result;
end;
$$;

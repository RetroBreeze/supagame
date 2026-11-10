-- Immutable slot revisions and upload reservations. Payloads are client controlled,
-- never an authority for leaderboard scores or achievement unlocks.
create table sg_private.save_config (
  singleton boolean primary key default true check(singleton),
  max_slots integer not null default 10 check(max_slots between 1 and 1000),
  max_json_bytes bigint not null default 1048576 check(max_json_bytes between 1 and 1048576),
  max_binary_bytes bigint not null default 52428800 check(max_binary_bytes between 1 and 5368709120),
  max_total_bytes bigint not null default 104857600 check(max_total_bytes between 1 and 53687091200),
  max_pending integer not null default 20 check(max_pending between 1 and 100)
);
insert into sg_private.save_config default values;
create table public.game_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot text not null check(slot ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  schema_version integer not null default 1 check(schema_version between 1 and 2147483647),
  kind text not null default 'json' check(kind in ('json','binary')),
  data jsonb,
  metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=4096),
  object_path text,
  size_bytes bigint not null default 0,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,slot)
);
-- Receipts keep a hash and metadata, not a second copy of large JSON. Replays
-- acknowledge the original revision; they never resurrect its old slot contents.
create table sg_private.save_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,operation_id)
);
-- Deliberately survives Auth deletion, so maintenance can still find objects.
create table sg_private.save_objects (
  path text primary key,
  user_id uuid not null,
  operation_id uuid not null,
  slot text not null,
  request jsonb not null,
  state text not null check(state in ('pending','live','garbage')),
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  unique(user_id,operation_id)
);
alter table public.game_saves enable row level security;
alter table sg_private.save_config enable row level security;
alter table sg_private.save_operations enable row level security;
alter table sg_private.save_objects enable row level security;
revoke all on public.game_saves from public,anon,authenticated,service_role;
revoke all on sg_private.save_config,sg_private.save_operations,sg_private.save_objects from public,anon,authenticated,service_role;
grant select on public.game_saves to authenticated;
create policy supagame_saves_owner on public.game_saves for select to authenticated using(user_id=(select auth.uid()));

create function sg_private.save_record(s public.game_saves, include_data boolean default true) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('slot',s.slot,'revision',s.revision,'schemaVersion',s.schema_version,
 'kind',s.kind,'metadata',s.metadata,'sizeBytes',s.size_bytes,'deleted',s.deleted,
 'createdAt',s.created_at,'updatedAt',s.updated_at,'objectPath',s.object_path)
 || case when include_data and s.kind='json' then jsonb_build_object('data',s.data) else '{}'::jsonb end;
$$;
revoke all on function sg_private.save_record(public.game_saves,boolean) from public,anon,authenticated,service_role;

create function public.sg_cloud_save(p_action text,p_slot text default null,p_request jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid := auth.uid(); s public.game_saves; cfg sg_private.save_config;
 op uuid; expected bigint; fingerprint text; receipt sg_private.save_operations;
 obj sg_private.save_objects; n bigint; bytes bigint; result jsonb; path text;
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
 allowed:=case when p_action in ('commit','abort') then array['operationId'] when p_action='delete' then array['operationId','expectedRevision'] when p_action='save' then array['operationId','expectedRevision','schemaVersion','data','metadata'] else array['operationId','expectedRevision','schemaVersion','sizeBytes','metadata'] end;
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
  path:=u::text||'/'||op::text;
  insert into sg_private.save_objects values(path,u,op,p_slot,p_request,'pending',bytes,now());
  return jsonb_build_object('upload',jsonb_build_object('bucket','supagame-saves','path',path,'operationId',op));
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
revoke all on function public.sg_cloud_save(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sg_cloud_save(text,text,jsonb) to authenticated;

-- Storage must be enabled before applying this migration. Never take over an
-- existing bucket with a conflicting definition.
do $$ begin
 if exists(select 1 from storage.buckets where id='supagame-saves') then
  raise exception 'SUPAGAME_SAVE_BUCKET_CONFLICT';
 end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit) values('supagame-saves','supagame-saves',false,52428800);
create function public.sg_save_object_access(p_name text,p_action text) returns boolean
language sql security definer stable set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from sg_private.save_objects o
 where o.path=p_name and o.user_id=auth.uid() and
 case p_action when 'read' then true when 'insert' then o.state='pending' and o.created_at>now()-interval '24 hours' when 'delete' then o.state='garbage' else false end);
$$;
revoke all on function public.sg_save_object_access(text,text) from public,anon,authenticated,service_role;
grant execute on function public.sg_save_object_access(text,text) to authenticated,anon;
-- Restrictive guards protect this bucket even when a host has broad permissive
-- policies for other modules. All unrelated buckets retain their own policies.
create policy supagame_saves_read on storage.objects for select to authenticated using(bucket_id='supagame-saves' and public.sg_save_object_access(name,'read'));
create policy supagame_saves_insert on storage.objects for insert to authenticated with check(bucket_id='supagame-saves' and public.sg_save_object_access(name,'insert'));
create policy supagame_saves_delete on storage.objects for delete to authenticated using(bucket_id='supagame-saves' and public.sg_save_object_access(name,'delete'));
create policy supagame_saves_read_guard on storage.objects as restrictive for select to anon,authenticated using(bucket_id<>'supagame-saves' or public.sg_save_object_access(name,'read'));
create policy supagame_saves_insert_guard on storage.objects as restrictive for insert to anon,authenticated with check(bucket_id<>'supagame-saves' or public.sg_save_object_access(name,'insert'));
create policy supagame_saves_delete_guard on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'supagame-saves' or public.sg_save_object_access(name,'delete'));
create policy supagame_saves_update_guard on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'supagame-saves') with check(bucket_id<>'supagame-saves');

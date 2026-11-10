-- A reservation must bound bytes at upload time, not merely at metadata commit.
create function public.sg_save_upload_size(p_name text,p_size text) returns boolean
language sql stable security definer set search_path='' as $$
 select case when p_size ~ '^[0-9]{1,13}$' then exists(
  select 1 from sg_private.save_objects o where o.path=p_name and o.user_id=auth.uid()
  and o.state='pending' and o.created_at>now()-interval '24 hours'
  and p_size::bigint between 1 and o.size_bytes
 ) else false end;
$$;
revoke all on function public.sg_save_upload_size(text,text) from public,anon,authenticated,service_role;
grant execute on function public.sg_save_upload_size(text,text) to anon,authenticated;
create policy supagame_saves_size_guard on storage.objects as restrictive for insert to anon,authenticated
 with check(bucket_id<>'supagame-saves' or public.sg_save_upload_size(name,metadata->>'size'));

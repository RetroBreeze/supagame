-- PostgREST table GETs run in read-only transactions. Direct reads use a snapshot
-- existence check; mutations and Storage authorization keep Auth-row SHARE locks.
create or replace function public.sg_save_identity_active() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users where id=auth.uid() and deleted_at is null);
$$;

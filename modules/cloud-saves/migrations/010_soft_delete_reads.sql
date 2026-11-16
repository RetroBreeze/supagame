-- A soft-deleted Auth row still satisfies a foreign key. Protect direct Data API
-- SELECT as well as the RPC and Storage paths. Exposes only the caller's status.
create function public.sg_save_identity_active() returns boolean
language sql volatile security definer set search_path='' as $$
 select sg_private.lock_save_identity();
$$;
revoke all on function public.sg_save_identity_active() from public,anon,authenticated,service_role;
grant execute on function public.sg_save_identity_active() to authenticated;
create policy supagame_saves_active_identity on public.game_saves
 as restrictive for select to authenticated
 using((select public.sg_save_identity_active()));

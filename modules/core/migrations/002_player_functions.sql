-- Additive migration; requires core/001_players.sql. No table grants change.
create function public.sg_get_my_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_profile jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end if;

  insert into public.game_players (user_id) values (v_user_id)
    on conflict (user_id) do nothing;

  -- Separate statement: at READ COMMITTED, see a concurrent creator after the
  -- INSERT waits for it. Never reset an existing name, timestamp or hidden flag.
  select pg_catalog.jsonb_build_object(
    'playerId', player.user_id,
    'displayName', player.display_name,
    'createdAt', player.created_at
  ) into v_profile
  from public.game_players as player
  where player.user_id = v_user_id;

  return v_profile;
exception
  when invalid_text_representation or foreign_key_violation then
    -- Invalid subjects and deleted/nonexistent Auth users fail without leaking
    -- UUID parser details or internal table/constraint names.
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
end;
$function$;

create function public.sg_update_my_profile(p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_display_name text;
  v_profile jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
  end if;

  -- Explicit Unicode whitespace avoids locale-dependent trimming. C0/C1 control
  -- characters inside the normalized name are forbidden, matching the contract.
  v_display_name := pg_catalog.btrim(p_display_name,
    U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if v_display_name is null
    or pg_catalog.char_length(v_display_name) not between 3 and 24
    or v_display_name ~ U&'[\0001-\001F\007F-\009F]'
  then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;

  insert into public.game_players as player (user_id, display_name)
    values (v_user_id, v_display_name)
    on conflict (user_id) do update set display_name = excluded.display_name
    returning pg_catalog.jsonb_build_object(
      'playerId', player.user_id,
      'displayName', player.display_name,
      'createdAt', player.created_at
    ) into v_profile;

  return v_profile;
exception
  when invalid_text_representation or foreign_key_violation then
    raise exception using errcode = '28000', message = 'UNAUTHORIZED';
end;
$function$;

-- Revoke PostgreSQL's PUBLIC execute default and Supabase's automatic grants.
-- Only player sessions may call these RPCs; each also checks auth.uid() itself.
revoke all on function public.sg_get_my_profile(), public.sg_update_my_profile(text)
  from public, anon, authenticated, service_role;
grant execute on function public.sg_get_my_profile(), public.sg_update_my_profile(text)
  to authenticated;

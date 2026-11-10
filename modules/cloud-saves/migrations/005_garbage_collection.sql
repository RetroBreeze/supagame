-- Operator-only maintenance. Keep deleted-account and abandoned-upload objects
-- discoverable until the Storage API confirms physical deletion.
create function sg_private.prepare_save_cleanup(p_paths text[]) returns setof text
language plpgsql set search_path='' as $$
declare o sg_private.save_objects;
begin
 if cardinality(p_paths)>100 then raise exception 'Cleanup batches are limited to 100 objects'; end if;
 for o in select * from sg_private.save_objects where path=any(p_paths) order by user_id,path loop
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('supagame:saves:'||o.user_id::text,0));
  -- Re-read after obtaining the same lock used by slot commits. A concurrent
  -- successful replacement must not become a cleanup victim.
  update sg_private.save_objects current set state='garbage'
  where current.path=o.path and
   (current.state='garbage' or (current.state='pending' and current.created_at<now()-interval '24 hours') or not exists(select 1 from auth.users where id=current.user_id))
   and not exists(select 1 from public.game_saves where object_path=current.path and not deleted);
  if found then return next o.path; end if;
 end loop;
end;
$$;
create function sg_private.finish_save_cleanup(p_paths text[]) returns integer
language plpgsql set search_path='' as $$
declare removed integer;
begin
 delete from sg_private.save_objects o where path=any(p_paths) and state='garbage'
 and not exists(select 1 from storage.objects where bucket_id='supagame-saves' and name=o.path);
 get diagnostics removed=row_count; return removed;
end;
$$;
revoke all on function sg_private.prepare_save_cleanup(text[]),sg_private.finish_save_cleanup(text[]) from public,anon,authenticated,service_role;

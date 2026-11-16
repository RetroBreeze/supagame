-- Timestamp ties or clock corrections must not reorder newly completed operations.
-- Existing receipts keep sequence zero and their historical timestamp ordering.
alter table sg_private.save_state add column completed_count bigint not null default 0 check(completed_count>=0);
alter table sg_private.save_operations add column completion_sequence bigint not null default 0 check(completion_sequence>=0);
create function sg_private.order_save_receipt() returns trigger
language plpgsql set search_path='' as $$
begin
 -- Public RPCs already own the Auth and per-player locks. Direct inserts are
 -- restricted to trusted database operators; no client may invoke this helper.
 insert into sg_private.save_state(user_id) values(new.user_id) on conflict do nothing;
 update sg_private.save_state set completed_count=completed_count+1
 where user_id=new.user_id returning completed_count into new.completion_sequence;
 return new;
end;
$$;
revoke all on function sg_private.order_save_receipt() from public,anon,authenticated,service_role;
create trigger supagame_save_receipt_order before insert on sg_private.save_operations
 for each row execute function sg_private.order_save_receipt();
drop index sg_private.save_receipts_retention;
create index save_receipts_retention on sg_private.save_operations(user_id,completion_sequence desc,created_at desc,operation_id desc);

create or replace function sg_private.maintain_save_history(u uuid) returns void
language plpgsql set search_path='' as $$
declare receipts uuid[]; tombstones text[]; over_capacity boolean;
begin
 perform sg_private.prune_save_revisions(u);
 select count(*)>=4096 into over_capacity from sg_private.save_operations where user_id=u;
 select array_agg(operation_id) into receipts from (
  select operation_id from sg_private.save_operations
  where user_id=u and (created_at<=clock_timestamp()-interval '30 days' or
   (over_capacity and operation_id not in (select operation_id from sg_private.save_operations where user_id=u order by completion_sequence desc,created_at desc,operation_id desc limit 3072)))
  order by completion_sequence,created_at,operation_id limit 1024
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


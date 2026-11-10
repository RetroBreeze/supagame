-- Storage checks a preflight insert with contentLength, then checks the actual
-- size again at completion. Both must fit the reservation.
alter policy supagame_saves_size_guard on storage.objects
 with check(bucket_id<>'supagame-saves' or public.sg_save_upload_size(name,coalesce(metadata->>'size',metadata->>'contentLength')));

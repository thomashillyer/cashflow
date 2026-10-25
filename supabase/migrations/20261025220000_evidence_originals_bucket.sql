-- Original files, messages and pasted text behind Evidence.storageKey (issue #155).
--
-- A private bucket. Nothing in it is readable or writable with the anon or authenticated keys: the
-- API reads and writes it with the service-role key (which bypasses RLS) after it has checked, in
-- server code, that the caller is a member of the business that owns the evidence. A browser must
-- never get a direct bucket URL (an uploaded HTML or SVG file would otherwise run in a storage origin
-- with the owner's session), so there is deliberately no policy that grants access.
--
-- storage.objects already has RLS on (no policy = no access). The RESTRICTIVE policy below makes that
-- explicit and keeps it true even if someone later adds a broad permissive policy to storage.objects:
-- a restrictive policy is ANDed with every permissive one, and this one is false for this bucket.

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence-originals', 'evidence-originals', false, 10485760)   -- 10 MB, the API's upload cap
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists evidence_originals_no_client_access on storage.objects;
create policy evidence_originals_no_client_access on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'evidence-originals')
  with check (bucket_id <> 'evidence-originals');

-- AN Tailor - bill PDF storage.
--
-- Bill PDFs live in one public bucket. Public read is deliberate: the link is
-- printed into a WhatsApp message and has to still open weeks later, and a
-- signed URL would expire inside it. Every object name is a random token, so
-- knowing the bucket is not enough to guess a customer's bill.
--
-- Run this once in the Supabase SQL editor. It is safe to run again.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bill-pdfs', 'bill-pdfs', true, 2097152, array['application/pdf'])
on conflict (id) do update
  set public              = excluded.public,
      file_size_limit     = excluded.file_size_limit,
      allowed_mime_types  = excluded.allowed_mime_types;

-- The bill as it was raised, kept so its PDF can be rebuilt byte for byte after
-- the file is exported and cleared. Without this, deleting a PDF from the bucket
-- would be the only copy in existence.
alter table bills add column if not exists pdf_snapshot jsonb;

drop policy if exists "bill pdfs are readable by anyone holding the link"
  on storage.objects;
create policy "bill pdfs are readable by anyone holding the link"
  on storage.objects for select
  using (bucket_id = 'bill-pdfs');

drop policy if exists "signed in staff can upload a bill pdf"
  on storage.objects;
create policy "signed in staff can upload a bill pdf"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'bill-pdfs');

drop policy if exists "signed in staff can replace a bill pdf"
  on storage.objects;
create policy "signed in staff can replace a bill pdf"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'bill-pdfs')
  with check (bucket_id = 'bill-pdfs');

drop policy if exists "signed in staff can remove a bill pdf"
  on storage.objects;
create policy "signed in staff can remove a bill pdf"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'bill-pdfs');
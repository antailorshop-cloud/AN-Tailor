-- AN TAILOR - allow the archive reminder Edge Function to use shop_settings.
--
-- This project was created with "Automatically expose new tables" turned off,
-- so supabase/schema.sql grants table privileges to `authenticated` only.
--
-- `service_role` bypasses RLS, but bypassing RLS is not the same as owning the
-- table: PostgREST still checks table privileges and returns
-- 42501 "permission denied for table shop_settings" without this grant.
--
-- The reminder needs:
--   select  - read archive_reminder_months and archive_reminder_last_sent_at
--   insert  - create the stamp row if it does not exist yet
--   update  - upsert a new stamp after a successful send
-- Delete is deliberately not granted.

grant usage on schema public to service_role;

grant select, insert, update on public.shop_settings to service_role;

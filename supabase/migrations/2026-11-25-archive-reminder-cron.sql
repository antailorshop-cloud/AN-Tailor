-- AN TAILOR - scheduled PDF archive reminder.
--
-- Run this in the Supabase SQL editor after:
--   1. deploying supabase/functions/archive-reminder
--   2. adding the Edge Function secrets GMAIL_USER, GMAIL_APP_PASSWORD,
--      REMINDER_TO and optionally SITE_URL
--   3. creating these Vault secrets (replace the placeholder values):
--
-- select vault.create_secret(
--   'https://<project-ref>.supabase.co',
--   'archive_reminder_project_url'
-- );
-- select vault.create_secret(
--   '<service_role_key>',
--   'archive_reminder_service_key'
-- );
--
-- The values stay in Vault and are never written into this file.
-- The Edge Function decides whether the interval saved in the app is due.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_archive_reminder(p_force boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  project_url text;
  service_key text;
  request_id bigint;
begin
  select decrypted_secret into project_url
    from vault.decrypted_secrets
   where name = 'archive_reminder_project_url';

  select decrypted_secret into service_key
    from vault.decrypted_secrets
   where name = 'archive_reminder_service_key';

  if project_url is null or service_key is null then
    raise exception 'Create the Vault secrets archive_reminder_project_url and archive_reminder_service_key first.';
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/archive-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_key,
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object('force', p_force),
    timeout_milliseconds := 30000
  ) into request_id;

  return request_id;
end;
$$;

-- The helper sends a service-role request, so keep it away from app users.
revoke all on function public.invoke_archive_reminder(boolean) from public;
grant execute on function public.invoke_archive_reminder(boolean) to service_role;

-- 03:30 UTC on the first of every month = 09:00 IST.
-- The function itself skips the email until archive_reminder_months has elapsed.
select cron.schedule(
  'an-tailor-archive-reminder',
  '30 3 1 * *',
  $$select public.invoke_archive_reminder(false);$$
);

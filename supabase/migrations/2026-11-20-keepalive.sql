-- Keep-alive endpoint for the Free plan.
--
-- Supabase pauses a Free project after 7 days without database activity. A
-- monitor outside the project (UptimeRobot, cron-job.org) calls this function
-- every few days, which runs a real query and resets that timer even while the
-- shop is closed.
--
-- It is SECURITY DEFINER so the anonymous key can call it without being given
-- read access to the tables. It returns only a row count, never any data, and
-- it is STABLE so PostgREST serves it over a plain GET (which is all a free
-- uptime monitor can send).
--
-- Run once in the Supabase SQL editor.

create or replace function public.ping()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.shop_settings;
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- Check it answers:
--   select public.ping();
-- and, once the project is live:
--   https://<project-ref>.supabase.co/rest/v1/rpc/ping?apikey=<anon-key>

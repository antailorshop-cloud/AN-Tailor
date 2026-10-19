-- AN TAILOR - restart record numbers after the owner clears data.
--
-- next_code() keeps a running counter per type in code_counters so a number is
-- never handed out twice, even when a record is deleted. That is right while the
-- records exist. But when the owner clears the shop's data - customers, orders,
-- bills - the shop expects the next record to be 0001 again, not to carry on
-- from a number whose record is gone.
--
-- Clearing rows cannot do this on its own: code_counters has RLS on with no
-- policies, so the API has no path to it at all. This SECURITY DEFINER function
-- is the only door, and it only opens for the owner.
--
-- Safe to run twice.

create or replace function public.reset_record_codes(p_prefixes text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can restart record numbers';
  end if;

  delete from public.code_counters
  where prefix = any (
    select upper(p) from unnest(coalesce(p_prefixes, '{}'::text[])) as p
  );

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

grant execute on function public.reset_record_codes(text[]) to authenticated;

-- AN TAILOR - record code format: AN-<TYPE>-<YY>-<NNNN>
--
--   AN            brand
--   CUS/MEA/ORD/BIL   record type
--   YY            two-digit year
--   NNNN          running serial, per type, reset each year
--
-- The serial is drawn from a counter table, not from the highest existing code,
-- so a number is never handed out twice - even when the record that used it is
-- deleted. The client falls back to reading the highest visible code when this
-- function is not installed yet, which is close but can reuse a number.
--
-- Safe to run twice.

create table if not exists public.code_counters (
  prefix     text primary key,
  year       int  not null,
  last_value int  not null default 0
);

-- The counter is an implementation detail, not a record. It is only ever
-- touched through next_code(), which runs as its owner. No policy here means
-- RLS denies direct access through the API, which is what is wanted.
alter table public.code_counters enable row level security;

create or replace function public.next_code(p_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := case upper(p_type)
                     when 'CUS' then 'CUS'
                     when 'MEA' then 'MEA'
                     when 'ORD' then 'ORD'
                     when 'BIL' then 'BIL'
                     else null
                   end;
  v_year   int  := extract(year from now())::int;
  v_yy     text := to_char(now(), 'YY');
  v_value  int;
begin
  if v_prefix is null then
    raise exception 'next_code: unknown record type %', p_type;
  end if;

  insert into public.code_counters (prefix, year, last_value)
  values (v_prefix, v_year, 1)
  on conflict (prefix) do update
    set last_value = case when public.code_counters.year = v_year
                          then public.code_counters.last_value + 1
                          else 1 end,
        year = v_year
  returning last_value into v_value;

  return 'AN-' || v_prefix || '-' || v_yy || '-' || lpad(v_value::text, 4, '0');
end;
$$;

grant execute on function public.next_code(text) to authenticated;

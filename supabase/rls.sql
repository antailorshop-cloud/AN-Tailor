-- AN TAILOR - Row Level Security, Phase 4
--
-- Business rules this encodes:
--   * Every staff member shares one customer list. Restricting staff from
--     seeing each other's customers would break the shop, so that is NOT
--     a rule here.
--   * Staff run the day-to-day: they create and edit customers, measurements,
--     orders, items, payments and bills.
--   * Master data and configuration belong to the owner: prices, dress types,
--     shop settings, staff accounts and access levels.
--   * Nothing is hard-deleted. Staff archive; only the owner deletes.
--   * A signed-out visitor reads nothing. No table has a policy for `anon`,
--     so with RLS enabled every table denies by default.
--
-- Run schema.sql first.

-- ============================================================
-- ROLE HELPERS
--
-- security definer so reading `profiles` does not recurse back into
-- this same policy. search_path is pinned to stop a caller from
-- shadowing these names.
-- ============================================================

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'owner'
      and p.active
  );
$$;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
  );
$$;

revoke all on function public.is_owner()  from public;
revoke all on function public.is_member() from public;
grant execute on function public.is_owner()  to authenticated;
grant execute on function public.is_member() to authenticated;

-- ============================================================
-- PROFILES  - you can read yourself; only the owner sees everyone
-- ============================================================

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_owner());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists profiles_write_owner on public.profiles;
create policy profiles_write_owner on public.profiles
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- A member must never be able to raise their own role.
create or replace function public.block_role_escalation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- auth.uid() is null when the statement comes from the SQL editor,
  -- service_role, a cron job or a migration. Those callers already hold
  -- database-level access, so this guard must not stand in their way --
  -- otherwise the first owner account can never be created.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_owner() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'Only the owner can change a role';
  end if;
  if new.active is distinct from old.active then
    raise exception 'Only the owner can activate or deactivate an account';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.block_role_escalation();

-- ============================================================
-- STAFF ACCESS  - owner only, in both directions
-- ============================================================

drop policy if exists staff_access_owner_all on public.staff_access;
create policy staff_access_owner_all on public.staff_access
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists staff_access_read_self on public.staff_access;
create policy staff_access_read_self on public.staff_access
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ============================================================
-- SHOP SETTINGS  - everyone reads, only the owner writes
-- ============================================================

drop policy if exists settings_read on public.shop_settings;
create policy settings_read on public.shop_settings
  for select to authenticated
  using (public.is_member());

drop policy if exists settings_write_owner on public.shop_settings;
create policy settings_write_owner on public.shop_settings
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- ============================================================
-- MASTER DATA  - prices, dress types: read for all, write for owner
-- ============================================================

drop policy if exists prices_read on public.prices;
create policy prices_read on public.prices
  for select to authenticated
  using (public.is_member());

drop policy if exists prices_write_owner on public.prices;
create policy prices_write_owner on public.prices
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists dress_types_read on public.dress_types;
create policy dress_types_read on public.dress_types
  for select to authenticated
  using (public.is_member());

drop policy if exists dress_types_write_owner on public.dress_types;
create policy dress_types_write_owner on public.dress_types
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- ============================================================
-- RESALE STOCK  - staff record purchases, owner edits and deletes
-- ============================================================

drop policy if exists resale_read on public.resale_stock;
create policy resale_read on public.resale_stock
  for select to authenticated
  using (public.is_member());

drop policy if exists resale_insert_member on public.resale_stock;
create policy resale_insert_member on public.resale_stock
  for insert to authenticated
  with check (public.is_member());

drop policy if exists resale_update_owner on public.resale_stock;
create policy resale_update_owner on public.resale_stock
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists resale_delete_owner on public.resale_stock;
create policy resale_delete_owner on public.resale_stock
  for delete to authenticated
  using (public.is_owner());

-- ============================================================
-- DAY-TO-DAY TABLES
-- customers, measurements, orders, order_items, payments, bills, bill_orders
-- staff may add and edit; only the owner may hard-delete
-- ============================================================

drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers
  for select to authenticated
  using (public.is_member() and archived_at is null or public.is_owner());

drop policy if exists customers_write_member on public.customers;
create policy customers_write_member on public.customers
  for insert to authenticated
  with check (public.is_member());

drop policy if exists customers_update_member on public.customers;
create policy customers_update_member on public.customers
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists customers_delete_owner on public.customers;
create policy customers_delete_owner on public.customers
  for delete to authenticated
  using (public.is_owner());

drop policy if exists measurements_read on public.measurements;
create policy measurements_read on public.measurements
  for select to authenticated
  using (public.is_member() and archived_at is null or public.is_owner());

drop policy if exists measurements_write_member on public.measurements;
create policy measurements_write_member on public.measurements
  for insert to authenticated
  with check (public.is_member());

drop policy if exists measurements_update_member on public.measurements;
create policy measurements_update_member on public.measurements
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists measurements_delete_owner on public.measurements;
create policy measurements_delete_owner on public.measurements
  for delete to authenticated
  using (public.is_owner());

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders
  for select to authenticated
  using (public.is_member() and archived_at is null or public.is_owner());

drop policy if exists orders_write_member on public.orders;
create policy orders_write_member on public.orders
  for insert to authenticated
  with check (public.is_member());

drop policy if exists orders_update_member on public.orders;
create policy orders_update_member on public.orders
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists orders_delete_owner on public.orders;
create policy orders_delete_owner on public.orders
  for delete to authenticated
  using (public.is_owner());

drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items
  for select to authenticated
  using (public.is_member());

drop policy if exists order_items_write_member on public.order_items;
create policy order_items_write_member on public.order_items
  for insert to authenticated
  with check (public.is_member());

drop policy if exists order_items_update_member on public.order_items;
create policy order_items_update_member on public.order_items
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists order_items_delete_member on public.order_items;
create policy order_items_delete_member on public.order_items
  for delete to authenticated
  using (public.is_member() or public.is_owner());

drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments
  for select to authenticated
  using (public.is_member());

drop policy if exists payments_write_member on public.payments;
create policy payments_write_member on public.payments
  for insert to authenticated
  with check (public.is_member());

drop policy if exists payments_update_member on public.payments;
create policy payments_update_member on public.payments
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists payments_delete_owner on public.payments;
create policy payments_delete_owner on public.payments
  for delete to authenticated
  using (public.is_owner());

drop policy if exists bills_read on public.bills;
create policy bills_read on public.bills
  for select to authenticated
  using (public.is_member() and archived_at is null or public.is_owner());

drop policy if exists bills_write_member on public.bills;
create policy bills_write_member on public.bills
  for insert to authenticated
  with check (public.is_member());

drop policy if exists bills_update_member on public.bills;
create policy bills_update_member on public.bills
  for update to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists bills_delete_owner on public.bills;
create policy bills_delete_owner on public.bills
  for delete to authenticated
  using (public.is_owner());

drop policy if exists bill_orders_read on public.bill_orders;
create policy bill_orders_read on public.bill_orders
  for select to authenticated
  using (public.is_member());

drop policy if exists bill_orders_write_member on public.bill_orders;
create policy bill_orders_write_member on public.bill_orders
  for insert to authenticated
  with check (public.is_member());

drop policy if exists bill_orders_delete_member on public.bill_orders;
create policy bill_orders_delete_member on public.bill_orders
  for delete to authenticated
  using (public.is_member() or public.is_owner());

-- ============================================================
-- PROFILE CREATED ON SIGNUP
--
-- Supabase Auth writes a row to auth.users and nothing else. Without
-- this trigger, public.profiles stays empty, is_member() returns false
-- for everyone, and RLS quietly blocks all access while every policy
-- still looks correct.
--
-- New accounts are always created as 'staff'. Promotion to owner is a
-- deliberate manual step, never automatic.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, role, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    'staff',
    true
  )
  on conflict (id) do nothing;

  insert into public.staff_access (user_id, area, level)
  select new.id, area, 1
  from unnest(array[
    'DASHBOARD', 'CUSTOMERS', 'MEASUREMENTS',
    'ORDERS', 'BILLS', 'PAYMENTS', 'RESALE'
  ]) as area
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill in case any account already exists.
insert into public.profiles (id, email, display_name, role, active)
select
  u.id,
  coalesce(u.email, ''),
  split_part(coalesce(u.email, ''), '@', 1),
  'staff',
  true
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

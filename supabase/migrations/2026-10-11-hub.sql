-- AN TAILOR - hub migration for v43: promised dates, stock alerts, voided
-- bills, and the audit log.
--
-- Every statement is guarded so the file is safe to run twice.

-- A date the tailor promised the garment, separate from the print delivery
-- date. The dashboard buckets open orders against it (overdue / due today /
-- upcoming).
alter table orders add column if not exists promise_date date;

create index if not exists orders_promise_idx on orders (promise_date)
  where status <> 'Cancelled' and archived_at is null;

-- How many units an item must have before the "low stock" badge stops. The old
-- threshold was a fixed constant of five; this lets one item be scarcer than
-- another on purpose.
alter table resale_stock add column if not exists min_qty numeric(12,3) not null default 5;

-- A printed bill can be wrong. Leaving it live keeps the money figures wrong;
-- deleting it loses the record. VOID keeps the row visible to the ledger (with
-- its totals zeroed out of any outstanding) and marks it clearly.
alter table bills add column if not exists status text not null default 'ACTIVE';

create index if not exists bills_status_idx on bills (status) where archived_at is null;

-- Who changed what, in the shop's own words. The app writes a row on the
-- moments that matter (a status move, a payment, a price change, a role), so a
-- dispute has a trail without any table being hard-deleted to make one.
-- Staff may write under their own identity; only the owner may read the whole
-- log.
create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references profiles(id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log (created_at desc);

alter table audit_log enable row level security;

do $$ begin
  create policy audit_log_insert_member on audit_log
    for insert to authenticated
    with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_log_select_owner on audit_log
    for select to authenticated
    using (public.is_owner());
exception when duplicate_object then null; end $$;
-- ============================================================
-- Per-garment status: one order can hold items at different stages.
--
-- The order keeps its own status and its own WhatsApp workflow. This
-- column is only the progress of each garment in the order, so it is
-- safe to add without touching Finish/Delivery automation or filters.
--
-- The five existing order_status labels are reused, but the UI offers
-- only Pending, Process, Finish and Delivery for an item: Cancelling
-- stays an order-level act because it changes the order's money.
--
-- Run this BEFORE deploying the frontend that writes order_items.status.
-- The other way round, saving an item would fail with "column
-- order_items.status does not exist" until this lands.
--
-- Safe to run more than once. Existing rows get Pending, and a database
-- built fresh from schema.sql already has the column.
-- ============================================================

alter table order_items
  add column if not exists status order_status not null default 'Pending';

-- The add above covers a normal upgrade. These two lines also repair a
-- database where the column was added earlier as nullable by hand.
update order_items set status = 'Pending' where status is null;
alter table order_items alter column status set default 'Pending';
alter table order_items alter column status set not null;

create index if not exists order_items_status_idx on order_items (status);

-- ============================================================
-- Order status rename: the shop's own words for its stages.
--
-- The five stages are the same five stages, only renamed:
--   In Progress -> Process
--   Ready       -> Finish
--   Delivered   -> Delivery
-- Pending and Cancelled are unchanged.
--
-- RENAME VALUE rewrites the enum label in place, so every existing
-- row follows the rename without an update of its own - there is
-- nothing to migrate row by row, and nothing to re-import.
--
-- This file is safe to run more than once: each rename is guarded
-- on the old label still being present, so a second run is a
-- no-op rather than an error. schema.sql already creates the enum
-- with the new labels, so a database built fresh from schema.sql
-- needs nothing from here.
--
-- Run this BEFORE deploying the frontend that sends the new words.
-- The other way round, saving an order would fail with "invalid
-- input value for enum order_status" until the rename lands.
-- ============================================================

do $$
begin
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'order_status' and e.enumlabel = 'In Progress'
  ) then
    alter type order_status rename value 'In Progress' to 'Process';
  end if;

  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'order_status' and e.enumlabel = 'Ready'
  ) then
    alter type order_status rename value 'Ready' to 'Finish';
  end if;

  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'order_status' and e.enumlabel = 'Delivered'
  ) then
    alter type order_status rename value 'Delivered' to 'Delivery';
  end if;
end $$;
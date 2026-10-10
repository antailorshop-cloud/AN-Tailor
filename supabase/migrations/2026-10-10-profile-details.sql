-- ============================================================
-- Profile details: a person keeps their own phone and address.
--
-- The account page lets a signed-in user edit their own display
-- name, phone and address. `profiles_update_self` in rls.sql
-- already lets the row owner update their own row, and the
-- protect trigger still blocks role/active changes, so these two
-- optional columns widen nobody's reach - they are columns on a
-- row the person could already write.
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS.
--
-- Run this BEFORE deploying the frontend that reads phone and
-- address in auth.loadProfile. The other way round, a sign in
-- would fail on a column that does not exist yet.
-- ============================================================

alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists address text;

-- AN TAILOR - master data seed.
--
-- Dress types and prices are the two tables an order line depends on, so they
-- must hold real values before Orders can be used. This file copies the
-- defaults the legacy Apps Script system seeded for itself, so the two systems
-- label the same garment the same way.
--
-- Prices are seeded at 0 on purpose. The legacy sheet also seeded 0 and the
-- owner typed the real amounts in over time. Putting an invented number here
-- would be worse than an honest blank: a wrong charge on a real bill is harder
-- to notice than a zero.
--
-- Safe to run more than once. The unique constraints on
-- (group_name, item, option) and (category, dress_type) make the inserts
-- idempotent, so a second run inserts nothing and reports the conflict.
--
-- Run this in the Supabase SQL editor.

begin;

-- ============================================================
-- DRESS TYPES
-- ============================================================

insert into public.dress_types (category, dress_type, is_default)
values
  ('Gents',   'Shirt',             true),
  ('Gents',   'T-Shirt',           true),
  ('Gents',   'Kurta',             true),
  ('Gents',   'Pant / Trouser',    true),
  ('Gents',   'Dhoti',             true),
  ('Gents',   'Waistcoat',         true),
  ('Gents',   'Sherwani',          true),
  ('Gents',   'Safari Suit',       true),
  ('Gents',   'Suit / Blazer',     true),
  ('Ladies',  'Blouse',            true),
  ('Ladies',  'Churidar / Salwar', true),
  ('Ladies',  'Kurti',             true),
  ('Ladies',  'Salwar Kameez',     true),
  ('Ladies',  'Anarkali',          true),
  ('Ladies',  'Lehenga Blouse',    true),
  ('Ladies',  'Pant',              true),
  ('Ladies',  'Palazzo',           true),
  ('Ladies',  'Maxi',              true),
  ('Ladies',  'Nighty',            true)
on conflict (category, dress_type) do nothing;

-- ============================================================
-- PRICES
--
-- TAILORING rows carry an option, because the same garment costs more with a
-- lining. SERVICE and RESALE rows use '-' for the option so the column is
-- never empty, which keeps the unique constraint meaningful.
-- ============================================================

insert into public.prices (code, group_name, item, option, price, extra_charge, status)
values
  ('P-001', 'TAILORING', 'Blouse',           'Without Lining', 0, 0, 'ACTIVE'),
  ('P-002', 'TAILORING', 'Blouse',           'With Lining',    0, 0, 'ACTIVE'),
  ('P-003', 'TAILORING', 'Salwar / Churidar','Without Lining', 0, 0, 'ACTIVE'),
  ('P-004', 'TAILORING', 'Salwar / Churidar','With Lining',    0, 0, 'ACTIVE'),
  ('P-005', 'TAILORING', 'Chudi',            'Without Lining', 0, 0, 'ACTIVE'),
  ('P-006', 'TAILORING', 'Chudi',            'With Lining',    0, 0, 'ACTIVE'),
  ('P-007', 'TAILORING', 'Kurthi',           'Without Lining', 0, 0, 'ACTIVE'),
  ('P-008', 'TAILORING', 'Kurthi',           'With Lining',    0, 0, 'ACTIVE'),
  ('P-009', 'SERVICE',   'Aari Work',        '-',              0, 0, 'ACTIVE'),
  ('P-010', 'SERVICE',   'Ironing',          '-',              0, 0, 'ACTIVE'),
  ('P-011', 'SERVICE',   'Saree Pre-Pleating','-',             0, 0, 'ACTIVE'),
  ('P-012', 'SERVICE',   'Alteration',       '-',              0, 0, 'ACTIVE'),
  ('P-013', 'SERVICE',   'Embroidery',       '-',              0, 0, 'ACTIVE'),
  ('P-014', 'RESALE',    'Night',            '-',              0, 0, 'ACTIVE'),
  ('P-015', 'RESALE',    'Leggings',         '-',              0, 0, 'ACTIVE'),
  ('P-016', 'RESALE',    'Inskirts',         '-',              0, 0, 'ACTIVE'),
  ('P-017', 'RESALE',    'Blouse Material',  '-',              0, 0, 'ACTIVE')
on conflict (group_name, item, option) do nothing;

commit;

-- ============================================================
-- VERIFY
--
-- Both counts must match. Gents 9 + Ladies 10 = 19 dress types.
-- 4 variants x 2 lining options + 5 services + 4 resale = 17 prices.
-- ============================================================

select 'dress_types' as table_name, count(*) as rows from public.dress_types
union all
select 'prices', count(*) from public.prices;

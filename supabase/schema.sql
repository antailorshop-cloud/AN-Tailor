-- AN TAILOR - Supabase schema
-- Derived from the live Google Sheet on 2026-09-30.
-- Column order verified against Order.gs:45 (ORDERS), Order.gs:121 (ORDER_ITEMS),
-- Payment.gs:62 (PAYMENTS). The ORDERS and PAYMENTS header rows in the Sheet are
-- stale and were NOT used.

create extension if not exists "pgcrypto";

-- ============================================================
-- ROLES
-- ============================================================

do $$ begin
  create type member_role as enum ('owner', 'staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('Pending', 'In Progress', 'Ready', 'Delivered', 'Cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type priority_level as enum ('Normal', 'Urgent');
exception when duplicate_object then null; end $$;

-- ============================================================
-- PEOPLE
-- ============================================================

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text not null default '',
  role         member_role not null default 'staff',
  photo_path   text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists staff_access (
  user_id uuid not null references profiles(id) on delete cascade,
  area    text not null,
  level   smallint not null default 1 check (level in (1, 2)),
  primary key (user_id, area)
);

create table if not exists shop_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

-- ============================================================
-- CORE RECORDS
-- ============================================================

create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  mobile      text not null default '',
  address     text not null default '',
  notes       text not null default '',
  status      text not null default 'ACTIVE',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists customers_mobile_idx on customers (mobile);
create index if not exists customers_name_idx   on customers (lower(name));

create table if not exists measurements (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  customer_id uuid not null references customers(id) on delete cascade,
  category    text not null default '',
  dress_type  text not null default '',
  values      jsonb not null default '{}'::jsonb,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists measurements_customer_idx on measurements (customer_id, created_at desc);

create table if not exists resale_stock (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  item       text not null,
  quantity   numeric(12,3) not null default 0 check (quantity >= 0),
  buy_price  numeric(12,2) not null default 0,
  sell_price numeric(12,2) not null default 0,
  total_cost numeric(12,2) not null default 0,
  buy_date   date,
  notes      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  customer_id     uuid not null references customers(id) on delete restrict,
  measurement_id  uuid references measurements(id) on delete set null,
  order_date      date not null default current_date,
  delivery_date   date,
  status          order_status not null default 'Pending',
  priority        priority_level not null default 'Normal',
  total           numeric(12,2) not null default 0,
  advance         numeric(12,2) not null default 0,
  balance         numeric(12,2) not null default 0,
  notes           text not null default '',
  line_model      text not null default 'ITEMS',
  item_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz
);

create index if not exists orders_customer_idx on orders (customer_id, order_date desc);
create index if not exists orders_status_idx   on orders (status, delivery_date);
create index if not exists orders_delivery_idx on orders (delivery_date)
  where status <> 'Cancelled' and archived_at is null;

-- The legacy system kept one discount for the whole order and forced the
-- per-line discount to zero, so the discount belongs on the parent row:
--   balance = total - discount - advance
-- It was missing from the original create table, which would have left the
-- discount with nowhere to go. Added with IF NOT EXISTS so re-running this file
-- upgrades an existing database. order_items.discount is kept for a future
-- per-line discount and stays at 0 today.
alter table orders add column if not exists discount numeric(12,2) not null default 0;

create table if not exists order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  line_no         integer not null default 1,
  measurement_id  uuid references measurements(id) on delete set null,
  category        text not null default '',
  dress_type      text not null default '',
  service         text not null default 'Tailoring',
  variant         text not null default '',
  lining          text not null default '',
  resale_item_id  uuid references resale_stock(id) on delete set null,
  quantity        numeric(12,3) not null default 1 check (quantity > 0),
  rate            numeric(12,2) not null default 0,
  discount        numeric(12,2) not null default 0,
  extra_charge    numeric(12,2) not null default 0,
  line_total      numeric(12,2) not null default 0,
  delivery_date   date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists order_items_order_idx on order_items (order_id, line_no);

-- Staff are not allowed to hard-delete an order item, so they need a way to
-- withdraw a wrongly entered one without destroying the audit trail. Added
-- with IF NOT EXISTS so re-running this file upgrades an existing database.
alter table order_items add column if not exists archived_at timestamptz;

create index if not exists order_items_live_idx on order_items (order_id, line_no)
  where archived_at is null;

create table if not exists payments (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  order_id         uuid references orders(id) on delete set null,
  customer_id      uuid not null references customers(id) on delete restrict,
  amount           numeric(12,2) not null default 0,
  method           text not null default 'CASH',
  reference        text not null default '',
  previous_balance numeric(12,2) not null default 0,
  new_balance      numeric(12,2) not null default 0,
  notes            text not null default '',
  paid_on          date not null default current_date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists payments_customer_idx on payments (customer_id, paid_on desc);
create index if not exists payments_order_idx    on payments (order_id);

create table if not exists bills (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  customer_id    uuid not null references customers(id) on delete restrict,
  total          numeric(12,2) not null default 0,
  discount       numeric(12,2) not null default 0,
  advance        numeric(12,2) not null default 0,
  bill_amount    numeric(12,2) not null default 0,
  balance        numeric(12,2) not null default 0,
  bill_date      date not null default current_date,
  notes          text not null default '',
  method         text not null default '',
  paid_on        date,
  pdf_path       text,
  print_size     text not null default 'A4',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);

create index if not exists bills_customer_idx on bills (customer_id, bill_date desc);

create table if not exists bill_orders (
  bill_id  uuid not null references bills(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  primary key (bill_id, order_id)
);

create table if not exists prices (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  group_name   text not null,
  item         text not null,
  option       text not null default '',
  price        numeric(12,2) not null default 0,
  extra_charge numeric(12,2) not null default 0,
  status       text not null default 'ACTIVE',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (group_name, item, option)
);

create table if not exists dress_types (
  id         uuid primary key default gen_random_uuid(),
  category   text not null,
  dress_type text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (category, dress_type)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Every table above is switched on here. Phase 4 supplies and
-- verifies the policies. Until policies pass the six tests, no
-- real customer data may be imported.
-- ============================================================

alter table profiles       enable row level security;
alter table staff_access   enable row level security;
alter table shop_settings  enable row level security;
alter table customers      enable row level security;
alter table measurements   enable row level security;
alter table resale_stock   enable row level security;
alter table orders         enable row level security;
alter table order_items    enable row level security;
alter table payments       enable row level security;
alter table bills          enable row level security;
alter table bill_orders    enable row level security;
alter table prices         enable row level security;
alter table dress_types    enable row level security;

-- ============================================================
-- GRANTS
--
-- "Automatically expose new tables" was turned OFF when the
-- project was created, so privileges are granted here on
-- purpose instead of by default.
--
-- Division of labour: a GRANT says an authenticated user may
-- attempt an operation. The RLS policies in rls.sql decide who
-- actually succeeds. Nothing is granted to `anon`, so a signed
-- out visitor has no path to any table at all.
-- ============================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;

revoke all on all tables in schema public from anon;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- is_owner() and is_member() are created in rls.sql, which grants
-- execute on them. They are deliberately not referenced here, because
-- this file has to run before rls.sql exists.

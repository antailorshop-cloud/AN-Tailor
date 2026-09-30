# AN TAILOR - web app

Supabase + GitHub Pages + PWA replacement for the Apps Script system.

## Status

| Phase | Area | State |
| --- | --- | --- |
| 0 | Git, schema extraction | done |
| 1 | Frontend shell | done |
| 2 | GitHub + Supabase accounts | done |
| 3 | Database schema | done, 13 tables applied |
| 4 | RLS policies + security gate | **done, 24/24 passed** |
| 5 | Real auth in the frontend | done - Supabase sign-in, session restore, role from `profiles` |
| 6 | Customers | done - list, search, add, edit, archive, restore, delete |
| 7-12 | Measurements, Orders, Payments, Billing, migration | not started |

## Security

The gate lives in `supabase/tests/index.html` and is run from a browser,
because the Supabase SQL editor runs as a superuser and bypasses RLS entirely.
All 24 checks pass against the live project.

What is proven, not assumed:

- A signed-out visitor cannot read any table.
- Staff can run the day-to-day but cannot change prices, shop settings, or
  delete a customer.
- Staff cannot promote themselves to owner, and cannot read other staff
  accounts.
- The owner re-reads every row staff attacked and confirms the stored values
  are untouched.

A blocked write does **not** raise an error. Postgres filters the row out of
the result set, so the statement succeeds while affecting nothing. A policy can
therefore look correct in `pg_policies` and still be miswritten - only the
behavioural test proves it. Re-run the gate after any change to `rls.sql`.

## Data rules

- Staff never hard-delete. `order_items.archived_at` lets a wrongly entered
  item be withdrawn while the audit trail survives.
- `orders.customer_id` is `ON DELETE RESTRICT`, so a customer who has ever
  placed an order can never be removed, by anyone. Those customers are
  archived. The order history is the business record.
- Only the owner performs a real `DELETE`.

## Run locally

Double-click `serve.cmd`, then open <http://127.0.0.1:8080/>. A local HTTP
server is required: ES modules and CORS do not work over `file://`. The
machine has no Python and no Node, so `serve.ps1` uses .NET sockets.

The login screen posts the credentials to Supabase Auth. The role is then read
from the `profiles` table on every sign-in, never from the browser, and a
database trigger blocks a user from promoting themselves. A missing or
deactivated profile signs the user out rather than guessing a role.

## Configuration

The project URL and the `anon` "public" key are committed in `scripts/config.js`,
so the deployed site works with no setup. That key is public by design: it
travels with every browser request and anyone can read it from the network
tab. On its own it grants nothing, because Row Level Security decides what it
may see.

To point the app at a different Supabase project, or to rotate the key, copy
`config.local.example.js` to `config.local.js` and fill it in. That file loads
first and overrides the committed values, and it is gitignored so local
credentials never enter the repository.

Never commit the `service_role` key. Never send the database password.

## Structure

    index.html              shell, login screen
    manifest.webmanifest    PWA install + Android home screen
    sw.js                   offline cache
    serve.ps1 / serve.cmd   zero-install local server
    assets/                 icons
    styles/tokens.css       design tokens, light + dark
    styles/app.css          layout, nav, cards, forms, tables
scripts/config.js       areas, roles, credentials
scripts/supabase.js     Auth + PostgREST client, token refresh
scripts/auth.js         session, role lookup, sign-in/out
scripts/customers.js    customers list, search, add, edit, archive
scripts/app.js          theme, router, pages
    supabase/schema.sql     13 tables, RLS switched on, explicit grants
    supabase/rls.sql        role helpers, policies, signup trigger
    supabase/tests/         browser security gate

## Roles

`owner` sees every area. `staff` sees everything except Settings. The block is
enforced in the database, not only in the menu. The frontend hides what the
role cannot do; the database is what actually refuses.

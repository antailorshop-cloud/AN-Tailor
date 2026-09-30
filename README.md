# AN TAILOR - web app

Supabase + GitHub Pages + PWA replacement for the Apps Script system.

## Status

| Phase | Area | State |
| --- | --- | --- |
| 0 | Git, schema extraction | done |
| 1 | Frontend shell | done |
| 2 | GitHub + Supabase accounts | waiting on credentials |
| 3 | Database schema | `supabase/schema.sql` written, not yet applied |
| 4 | RLS policies + six security tests | blocked until 2 |
| 5 | Auth | not started |
| 6-12 | Customers, Measurements, Orders, Payments, Billing, PWA, migration | not started |

## Run locally

Open `index.html`, then use **Preview as Owner** or **Preview as Staff**.
Preview mode exists only while `scripts/config.js` has no Supabase keys.

## Structure

    index.html              shell, login screen
    manifest.webmanifest    PWA install + Android home screen
    sw.js                   offline cache
    assets/                 icons
    styles/tokens.css       design tokens, light + dark
    styles/app.css          layout, nav, cards, forms, tables
    scripts/config.js       Supabase keys, areas, roles
    scripts/auth.js         session and access checks
    scripts/app.js          theme, router, pages
    supabase/schema.sql     database schema, RLS switched on

## Roles

`owner` sees every area. `staff` sees everything except Settings. The block is
enforced in the database, not only in the menu.

## Rules

- Customer data never goes in this repository. Code only.
- Never commit the `service_role` key. The `anon` key is public by design.
- Do not connect the frontend to real data until the Phase 4 tests pass.

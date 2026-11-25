# PDF archive reminder

The reminder is sent by a **Supabase Edge Function** and scheduled by
**Supabase Cron**. No Gmail password is stored in GitHub or in the frontend.

## How it behaves

- The Owner saves the interval in **Settings -> Backup -> Archive reminder**:
  - 3 months
  - 6 months
  - 1 year
  - 1.5 years
- Supabase Cron runs on the first of every month at **03:30 UTC / 09:00 IST**.
- The function reads `archive_reminder_months` and
  `archive_reminder_last_sent_at` from `shop_settings`.
- It sends only when the saved interval has elapsed.
- Saving a new interval in the app restarts the clock from that day.
- The email contains links to the app only. It never clears storage.
- After a successful send, `archive_reminder_last_sent_at` is updated.

## 1. Deploy the Edge Function

The source is:

`supabase/functions/archive-reminder/index.ts`

With the Supabase CLI:

```bash
supabase functions deploy archive-reminder --no-verify-jwt
```

Or in the Supabase Dashboard:

1. Open **Edge Functions**.
2. Create a function named `archive-reminder`.
3. Paste the contents of `supabase/functions/archive-reminder/index.ts`.
4. Disable **Verify JWT** for this function.

JWT verification is disabled because the function checks for the
`service_role` key itself. The public anon key cannot call it.

## 2. Add the email secrets

In the Supabase Dashboard, open **Edge Functions -> Secrets** and add:

| Secret | Value |
| --- | --- |
| `GMAIL_USER` | The Gmail address that sends the reminder |
| `GMAIL_APP_PASSWORD` | The 16-character Google App Password |
| `REMINDER_TO` | The email address that receives the reminder |
| `SITE_URL` | Optional. Defaults to `https://antailorshop-cloud.github.io/AN-Tailor/` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied automatically to
the Edge Function. Do not add them as Gmail settings.

The Gmail account needs 2-Step Verification, and the password must be a Google
**App Password**, not the normal Gmail password.

To send the reminder to more than one address, put them in the same
`REMINDER_TO` value separated by commas:

```
owner@gmail.com, partner@gmail.com, accounts@gmail.com
```

The function trims each address, rejects the whole run if one is malformed, and
sends a single email to all of them.

## 3. Add the scheduler

Open the **SQL Editor** and run the file:

`supabase/migrations/2026-11-25-archive-reminder-cron.sql`

Before running it, replace the placeholders in the two `vault.create_secret`
statements near the top:

- `<project-ref>` with your Supabase project reference
- `<service_role_key>` with either:
  - the new **Secret key** (`sb_secret_...`) from **Settings -> API Keys**, or
  - the legacy **service_role** key from **Settings -> API Keys -> Legacy API keys**

Run those two `vault.create_secret` statements once. Then run the rest of the
migration. Do not commit the real values.

The function accepts both key formats. New `sb_secret_...` keys are sent only on
the `apikey` header; they must not be sent as `Authorization: Bearer`.

The migration creates:

- a helper function `public.invoke_archive_reminder`
- a monthly Cron job named `an-tailor-archive-reminder`

## 4. Test the reminder

In the Supabase SQL Editor:

```sql
select public.invoke_archive_reminder(true);
```

The `true` forces a send even if the saved interval has not elapsed. Check:

- **Edge Functions -> Logs** for the function result
- **Integrations -> Cron -> History** for the request
- the `REMINDER_TO` inbox and Spam folder

A successful function response looks like:

```json
{
  "sent": true,
  "months": 3,
  "interval": "3 months",
  "to": "owner@example.com",
  "forced": true
}
```

After it succeeds, `archive_reminder_last_sent_at` in `shop_settings` is updated
to the current time.

## 5. Normal schedule

The Cron job runs monthly and the function decides whether to send. A normal
run outside the saved interval returns:

```json
{
  "sent": false,
  "reason": "not_due",
  "interval": "3 months"
}
```

The email does not clear storage. Clearing still needs the Owner to be signed
in and to complete the archive tick, `CLEAR`, password check, and final
confirmation.

## 6. Troubleshooting

**`401 Unauthorized`**

The key in Vault does not match a key the function accepts. Update the Vault
secret with the current **Secret key** (`sb_secret_...`) from
**Settings -> API Keys -> Secret keys**, then redeploy the function.

**`500` with `Could not read shop settings (HTTP 403)`**

The request reached the function, but the key it used for the internal
PostgREST call was disabled or wrong. The function tries the key that
authenticated the request first, then the platform-provided secret keys, and
for `sb_secret_...` keys it retries with the `Bearer` header form. The error
now includes the PostgREST message, for example:

```
Could not read shop settings (HTTP 403). {"message":"permission denied for table shop_settings"}
```

If that still happens, copy the current Secret key into Vault again and
redeploy the function.

**`403` with `permission denied for table shop_settings`**

The key is valid, but `service_role` has no table privileges. This project was
created with automatic table exposure turned off, so run:

`supabase/migrations/2026-11-25-shop-settings-service-grant.sql`

```sql
grant usage on schema public to service_role;
grant select, insert, update on public.shop_settings to service_role;
```

RLS bypass does not replace a table grant, so this step is required once per
project.

**`No recipients defined`**

`REMINDER_TO` was saved but does not contain a usable email address. Usually
an invisible non-breaking space or a zero-width character came along with a
paste. Delete that secret and type the address by hand, for example
`owner@gmail.com`.

The current function strips those invisible characters and checks the address
before sending, so after updating the function the error reports the exact
value:

```
REMINDER_TO is not a valid email address: "..."
```

**`Email sent, but the last-sent stamp failed (HTTP 400)` with `PGRST102`**

The email was delivered; only the timestamp write was rejected because the
request body was labelled `text/plain`. The function now sends
`Content-Type: application/json` for the upsert. Redeploy the function and run
the forced test again. Because the stamp was not written, the next scheduled
run would otherwise send the reminder a second time.

Every response now starts with a `version` field. If `PGRST102` appears and the
response has no `version`, the deployed code is old: replace the whole function
body again and press **Deploy**.

To check which key Vault holds:

```sql
select name, length(decrypted_secret) as key_length
from vault.decrypted_secrets
where name = 'archive_reminder_service_key';
```

A legacy `service_role` key is a long JWT and a new secret key starts with
`sb_secret_`. Never paste either key into the repository.

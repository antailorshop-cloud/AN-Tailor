# PDF archive reminder

`.github/workflows/archive-reminder.yml` runs on the first of every month at
03:30 UTC / 09:00 IST. It reads the interval saved in the app and only sends an
email when that interval has elapsed since the last reminder.

The interval is set on **Settings → Backup → Archive reminder**:

- 3 months
- 6 months
- 1 year
- 1.5 years

Saving a choice restarts the clock from that day. A manual workflow run that
actually sends an email also restarts the clock.

## Gmail setup

1. Turn on 2-factor authentication for the Gmail account that will send the
   reminder.
2. Create a Google **App password** for that account. Use it only in GitHub
   Actions; never put it in `scripts/config.js` or any frontend file.
3. In the GitHub repository, add these Secrets:

   | Secret | Value |
   | --- | --- |
   | `GMAIL_USER` | Gmail address used to send the reminder |
   | `GMAIL_APP_PASSWORD` | 16-character Google App password |
   | `REMINDER_TO` | Email address that receives the reminder, normally the Owner |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key, used only by the scheduled job |

4. Optional: add a Repository variable `SITE_URL` if the app is served somewhere
   other than `https://antailorshop-cloud.github.io/AN-Tailor/`. Do not include a
   trailing `#`; the workflow adds the deep links. The default Supabase project
   URL is already in the workflow and can be overridden with a `SUPABASE_URL`
   Repository variable.

The service_role key bypasses Row Level Security, so it must never appear in a
frontend file, a commit, or a browser-visible setting. It stays in GitHub
Actions secrets.

## What the email contains

- A link to `https://antailorshop-cloud.github.io/AN-Tailor/#/settings/backup`
  for downloading both zips.
- A link to `https://antailorshop-cloud.github.io/AN-Tailor/#/settings/clear-pdfs`
  for opening the guarded clear panel.

The email does **not** clear storage. Clearing still needs the Owner to be signed
in and to complete every guard in the app.

## Testing

Run the workflow manually from the GitHub repository's **Actions** tab using
**Run workflow**:

- If the interval has not elapsed, the job reports “not due” and sends nothing.
- To force a test send, change the interval in the app first; saving restarts the
  clock, so an immediate manual run after a fresh install or missing last-sent
  stamp will send.

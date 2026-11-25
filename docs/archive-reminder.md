# Quarterly PDF archive reminder

`/.github/workflows/archive-reminder.yml` emails the Owner every three months to
download the CSV and PDF backups, upload them to Google Drive, and only then clear
the stored PDFs.

Schedule: `30 3 1 1,4,7,10 *` UTC, which is 09:00 IST on 1 January, April, July
and October.

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

4. Optional: add a Repository variable `SITE_URL` if the app is served somewhere
   other than `https://antailorshop-cloud.github.io/AN-Tailor/`. Do not include a
   trailing `#`; the workflow adds the deep links.

## What the email contains

- A link to `https://antailorshop-cloud.github.io/AN-Tailor/#/settings/backup`
  for downloading both zips.
- A link to `https://antailorshop-cloud.github.io/AN-Tailor/#/settings/clear-pdfs`
  for opening the guarded clear panel.

The email does **not** clear storage. Clearing still needs the Owner to be signed
in and to complete every guard in the app.

## Testing

Run the workflow manually from the GitHub repository's **Actions** tab using
**Run workflow**. The quarterly schedule will still run on its own after that.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import nodemailer from "npm:nodemailer@^9.0.0";

/* AN TAILOR - PDF archive reminder.
 *
 * Uploads are archived in Google Drive, but the reminder itself only opens
 * the app. It never clears storage. The Owner still has to download both
 * zips, upload them, and pass the guards in Settings -> Backup.
 *
 * The schedule lives in Supabase Cron; the interval lives in shop_settings.
 * This function decides whether the saved interval has elapsed, so changing
 * Settings -> Backup -> Archive reminder changes the next email without a
 * deploy.
 */

const INTERVALS = {
  3: "3 months",
  6: "6 months",
  12: "1 year",
  18: "1.5 years"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function setting(rows, key) {
  for (const row of rows || []) {
    if (row && row.key === key) return String(row.value == null ? "" : row.value);
  }
  return "";
}

function monthsFrom(value) {
  const n = Number.parseInt(String(value == null ? "" : value), 10);
  return INTERVALS[n] ? n : 3;
}

// Calendar months, not 30-day blocks: a reminder saved for 3 months on 31
// January is due on 30 April, because April has no 31st.
function addMonths(date, months) {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function siteBase() {
  return String(Deno.env.get("SITE_URL") || "https://antailorshop-cloud.github.io/AN-Tailor/")
    .replace(/\/+$/, "");
}

function emailText(label, base) {
  return [
    "Hello,",
    "",
    "Your saved archive interval is " + label + ". It is time to download the",
    "AN TAILOR backups and archive them in Google Drive.",
    "",
    "1. Open Backup and download both zips (CSV backup and PDF archive):",
    "   " + base + "/#/settings/backup",
    "",
    "2. Upload both zips to Google Drive.",
    "",
    "3. Only after both zips are safe in Drive, open Clear stored PDFs:",
    "   " + base + "/#/settings/clear-pdfs",
    "",
    "The clear panel needs the archive tick, the word CLEAR, your password",
    "and a final confirmation. This email only opens the app. It does not",
    "delete anything by itself.",
    "",
    "Bill records, payments and saved snapshots are kept when PDFs are",
    "cleared, so a later bill message can rebuild the file.",
    "",
    "AN TAILOR"
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-reminder-key",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supplied = req.headers.get("x-reminder-key") ||
    req.headers.get("apikey") ||
    String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  // This function can send email and write the last-sent stamp. The public
  // anon key must never be enough to call it.
  if (!serviceKey || supplied !== serviceKey) {
    return json({ error: "Unauthorized." }, 401);
  }

  let payload = {};
  try {
    payload = await req.json();
  } catch (_) {
    payload = {};
  }

  const force = payload && (payload.force === true || payload.force === "true");

  try {
    const projectUrl = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    if (!projectUrl) throw new Error("SUPABASE_URL is not available.");

    const readRes = await fetch(projectUrl + "/rest/v1/shop_settings?select=key,value", {
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey
      }
    });
    if (!readRes.ok) {
      throw new Error("Could not read shop settings (HTTP " + readRes.status + ").");
    }

    const rows = await readRes.json();
    const months = monthsFrom(setting(rows, "archive_reminder_months"));
    const label = INTERVALS[months];
    const last = setting(rows, "archive_reminder_last_sent_at");
    const lastDate = last ? new Date(last) : null;

    let dueAt = null;
    let due = true;
    if (!force && lastDate && !Number.isNaN(lastDate.getTime())) {
      dueAt = addMonths(lastDate, months);
      due = Date.now() >= dueAt.getTime();
    }

    if (!due) {
      return json({
        sent: false,
        reason: "not_due",
        months: months,
        interval: label,
        due_at: dueAt ? dueAt.toISOString() : null
      });
    }

    const gmailUser = Deno.env.get("GMAIL_USER") || "";
    const gmailPassword = Deno.env.get("GMAIL_APP_PASSWORD") || "";
    const reminderTo = Deno.env.get("REMINDER_TO") || "";
    if (!gmailUser || !gmailPassword || !reminderTo) {
      throw new Error("Set GMAIL_USER, GMAIL_APP_PASSWORD and REMINDER_TO as Edge Function secrets.");
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: gmailUser,
        pass: gmailPassword
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    });

    const base = siteBase();
    const sentAt = new Date().toISOString();

    await transporter.sendMail({
      from: gmailUser,
      to: reminderTo,
      subject: "AN TAILOR - " + label + " PDF archive reminder",
      text: emailText(label, base)
    });

    // Upsert the stamp. A failed write must be visible: otherwise the next
    // scheduled run would send the same reminder again.
    const saveRes = await fetch(projectUrl + "/rest/v1/shop_settings?on_conflict=key", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify([{ key: "archive_reminder_last_sent_at", value: sentAt }])
    });

    if (!saveRes.ok) {
      const detail = (await saveRes.text()).slice(0, 300);
      throw new Error("Email sent, but the last-sent stamp failed (HTTP " +
        saveRes.status + "). " + detail);
    }

    return json({
      sent: true,
      months: months,
      interval: label,
      to: reminderTo,
      sent_at: sentAt,
      forced: !!force
    });
  } catch (error) {
    console.error("archive-reminder failed:", error && error.message ? error.message : error);
    return json({
      sent: false,
      error: error && error.message ? error.message : String(error)
    }, 500);
  }
});

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

function secretKeys() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Object.keys(parsed || {}).map(function (name) { return parsed[name]; })
      .filter(function (value) { return typeof value === "string" && value; });
  } catch (_) {
    return [];
  }
}

function defaultSecretKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) || {};
    return typeof parsed.default === "string" ? parsed.default : "";
  } catch (_) {
    return "";
  }
}

function acceptedKeys() {
  return [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    Deno.env.get("SUPABASE_SECRET_KEY") || "",
    defaultSecretKey()
  ].concat(secretKeys()).filter(function (value) { return !!value; });
}

// Supabase projects can expose the legacy service_role JWT, the newer
// sb_secret_ key, or both. The key that authenticated this request is known to
// be valid for the project, so try it first and only then fall back to the
// platform-provided keys.
function candidateKeys(supplied) {
  const out = [];
  function add(value) {
    const key = String(value || "").trim();
    if (key && out.indexOf(key) === -1) out.push(key);
  }
  if (supplied) add(supplied);
  add(Deno.env.get("SUPABASE_SECRET_KEY"));
  add(defaultSecretKey());
  add(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  secretKeys().forEach(add);
  return out;
}

// Legacy service_role keys are JWTs. The newer sb_secret_ keys are opaque.
// The documented form for them is the apikey header alone; some projects also
// accept the supabase-js form with a Bearer header, so try both.
function headerModes(key) {
  if (key.indexOf("eyJ") === 0) {
    return [{ apikey: key, Authorization: "Bearer " + key }];
  }
  return [
    { apikey: key },
    { apikey: key, Authorization: "Bearer " + key }
  ];
}

// A project can keep a stale or disabled legacy service_role key in the
// environment while the newer sb_secret_ key is the working one. Try each
// candidate and stop at the first accepted response.
async function restRequest(label, projectUrl, path, supplied, init) {
  const keys = candidateKeys(supplied);
  if (!keys.length) throw new Error("No Supabase secret key is available to the function.");

  const options = init || {};
  let status = 0;
  let detail = "";

  for (const key of keys) {
    for (const mode of headerModes(key)) {
      const headers = Object.assign({}, mode);
      if (options.headers) {
        Object.keys(options.headers).forEach(function (name) {
          headers[name] = options.headers[name];
        });
      }
      const res = await fetch(projectUrl + path, {
        method: options.method || "GET",
        headers: headers,
        body: options.body
      });
      if (res.ok) return res;
      // Only auth failures justify another key or header form. A real 4xx/5xx
      // is reported to the caller as is.
      if (res.status !== 401 && res.status !== 403) return res;
      status = res.status;
      detail = ((await res.text()) || "").replace(/\s+/g, " ").slice(0, 300);
    }
  }

  throw new Error(label + " (HTTP " + status + "). " + detail);
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

  const supplied = req.headers.get("x-reminder-key") ||
    req.headers.get("apikey") ||
    String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const allowed = acceptedKeys();

  // This function can send email and write the last-sent stamp. The public
  // anon key must never be enough to call it.
  if (!allowed.length || allowed.indexOf(supplied) === -1) {
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

    const readRes = await restRequest(
      "Could not read shop settings",
      projectUrl,
      "/rest/v1/shop_settings?select=key,value",
      supplied
    );
    if (!readRes.ok) {
      throw new Error("Could not read shop settings (HTTP " + readRes.status + "). " +
        (await readRes.text()).slice(0, 300));
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
    const saveRes = await restRequest(
      "Could not save the last-sent stamp",
      projectUrl,
      "/rest/v1/shop_settings?on_conflict=key",
      supplied,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ key: "archive_reminder_last_sent_at", value: sentAt }])
      }
    );

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

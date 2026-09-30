// LOCAL CONFIG -- do not commit.
//
// Copy this file to "config.local.js" in the same folder and paste your
// own values in. config.local.js is gitignored, so your project URL
// and key stay out of the repository and can be rotated without a
// code change.
//
// The anon "public" key is designed to be visible in a browser, but
// keeping it out of git still avoids leaking it into screenshots,
// clones and build logs. Never put the service_role key here.

window.ANT = window.ANT || {};

window.ANT.local = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY-HERE'
};

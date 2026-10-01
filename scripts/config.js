window.ANT = window.ANT || {};

// Release stamp. Change this on every deploy. app.js refetches config.js with
// the cache bypassed and reloads the page when the stamp differs, so a new
// release reaches a phone that is already open without the user having to
// hard-refresh. Hash routing means clicking around the app never causes a
// page load, so without this check a running tab can stay on old code
// indefinitely.
var BUILD = '2026-10-01-19';

// config.local.js is loaded first and is gitignored. It exists so keys can be
// rotated, or a second project tried, without editing tracked code. The values
// below are the committed defaults and are what GitHub Pages deploys.
//
// The anon "public" key is safe to publish. It is designed to be visible: it
// travels in the browser on every request and anyone can read it from the
// browser's network tab regardless. On its own it grants nothing - Row Level
// Security decides what it is allowed to see, and the 24-check gate proves
// that. The service_role key bypasses RLS and must never appear in this file
// or in any file in this repository.
var local = window.ANT.local || {};

window.ANT.config = {
  appName: 'AN TAILOR',
  tagline: 'Professional Tailoring Services',
  build: BUILD,

  supabaseUrl: local.supabaseUrl || 'https://taidyazxtcouyihxfxfe.supabase.co',
  supabaseAnonKey: local.supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhaWR5YXp4dGNvdXlpaHhmeGZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NjcwODYsImV4cCI6MjEwNjM0MzA4Nn0.2m0x9-JcGVo-OjYsn6rR2HQjeXwM0toNpJ3l1pgMALc',

  storageKeys: {
    theme: 'anTailorTheme',
    session: 'anTailorSession'
  },

  roles: {
    owner: { label: 'Owner', rank: 2 },
    staff: { label: 'Staff', rank: 1 }
  },

  areas: [
    { id: 'dashboard', label: 'Dashboard', minRole: 'staff', phase: 1 },
    { id: 'customers', label: 'Customers', minRole: 'staff', phase: 6 },
    { id: 'measurements', label: 'Measurements', minRole: 'staff', phase: 7 },
    { id: 'orders', label: 'Orders', minRole: 'staff', phase: 8 },
    { id: 'bills', label: 'Bills', minRole: 'staff', phase: 10 },
    { id: 'payments', label: 'Payments', minRole: 'staff', phase: 9 },
    { id: 'resale', label: 'Resale Stock', minRole: 'staff', phase: 10 },
    { id: 'settings', label: 'Settings', minRole: 'owner', phase: 2 }
  ]
};

window.ANT.isBackendConfigured = function () {
  var c = window.ANT.config;
  return !!(c.supabaseUrl && c.supabaseAnonKey);
};

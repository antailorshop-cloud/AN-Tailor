window.ANT = window.ANT || {};

// config.local.js is loaded first and is gitignored, so credentials
// never enter the repository. If the file is missing, the app falls
// back to these placeholders and runs in preview mode.
var local = window.ANT.local || {};

window.ANT.config = {
  appName: 'AN TAILOR',
  tagline: 'Professional Tailoring Services',

  supabaseUrl: local.supabaseUrl || '',
  supabaseAnonKey: local.supabaseAnonKey || '',

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

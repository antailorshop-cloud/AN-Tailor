window.ANT = window.ANT || {};

window.ANT.auth = (function () {
  var cfg = window.ANT.config;
  var dbg = (cfg.storageKeys && cfg.storageKeys.session) || 'anTailorSession';

  function read() {
    try {
      return JSON.parse(localStorage.getItem(dbg) || 'null');
    } catch (e) {
      return null;
    }
  }

  function write(v) {
    try {
      if (v) localStorage.setItem(dbg, JSON.stringify(v));
      else localStorage.removeItem(dbg);
    } catch (e) {
      return;
    }
  }

  function canAccess(area, role) {
    if (!area) return false;
    var needed = area.minRole || 'staff';
    var have = cfg.roles[role];
    if (!have) return false;
    return have.rank >= cfg.roles[needed].rank;
  }

  function areasFor(role) {
    return cfg.areas.filter(function (a) {
      return canAccess(a, role);
    });
  }

  return {
    current: read,

    signOut: function () {
      write(null);
    },

    canAccess: canAccess,

    areasFor: areasFor,

    signIn: function (email, password) {
      return Promise.reject(new Error(
        'No database is connected yet. Add your Supabase URL and anon key to scripts/config.js, ' +
        'or use Preview mode below.'
      ));
    },

    previewSignIn: function (role) {
      var user = {
        id: 'preview-' + role,
        email: role === 'owner' ? 'owner@preview.local' : 'staff@preview.local',
        name: role === 'owner' ? 'Shop Owner' : 'Staff Member',
        role: role,
        preview: true
      };
      write(user);
      return user;
    }
  };
})();

/* AN TAILOR - authentication.
 *
 * The role is read from the `profiles` table on every sign in, never from the
 * Supabase user metadata and never from anything stored in the browser. A
 * signed-in user can read their own profile row and nothing else, and the role
 * column is protected by a trigger that blocks self-promotion, so this is the
 * one value that can be trusted.
 *
 * If the profile is missing or inactive, the app signs the person out rather
 * than falling back to a default role. Guessing "staff" here would be a
 * security hole; guessing "owner" would be worse.
 */

window.ANT = window.ANT || {};

window.ANT.auth = (function () {
  var cfg = window.ANT.config;
  var CACHE_KEY = 'anTailorCurrentUser';

  /* Access rules - the menu. The database is the real enforcement.
   *
   * Two things decide an area, and they can only ever subtract:
   *
   *   1. the role on the profile, which is the coarse switch, and
   *   2. the rows in staff_access, which is how the owner narrows one tailor to
   *      the counter they actually work.
   *
   * A person with no staff_access rows is left to their role. That default is
   * deliberate and it is the safe direction: an account created before this
   * feature existed has a profile and no rows, and reading the empty case as
   * "no access" would sign the owner out of their own shop with no way back in
   * but the database editor. Rows that are present always win, so a grant can
   * narrow a person to nothing but can never widen them past their role.
   */

  function canAccess(area, role, granted) {
    if (!area || !role) return false;
    var have = cfg.roles[role];
    var needed = cfg.roles[area.minRole || 'staff'];
    if (!have || !needed) return false;
    if (have.rank < needed.rank) return false;

    if (area.access && granted && granted.length) {
      return granted.indexOf(area.access) !== -1;
    }
    return true;
  }

  function areasFor(role, granted) {
    return cfg.areas.filter(function (a) {
      return canAccess(a, role, granted);
    });
  }

  // The rows a person has been given. A read that fails or is filtered by RLS
  // yields an empty list, which means "leave them to their role" - never a
  // reason to keep a tailor out of the app.
  function loadAreas(userId) {
    return window.ANT.sb.from('staff_access')
      .select('area')
      .eq('user_id', userId)
      .then(function (res) {
        if (res.error || !res.data) return [];
        return res.data.map(function (r) {
          return String(r.area || '');
        }).filter(function (a) {
          return a !== '';
        });
      })
      .catch(function () {
        return [];
      });
  }

  /* Cached profile, so a reload paints the shell before the network returns */

  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeCache(value) {
    try {
      if (value) localStorage.setItem(CACHE_KEY, JSON.stringify(value));
      else localStorage.removeItem(CACHE_KEY);
    } catch (e) {
      return;
    }
  }

  /* Error text. Supabase's defaults are accurate but unhelpful on a shop floor. */

  function friendly(message) {
    var m = String(message || '');
    if (/invalid login credentials/i.test(m)) {
      return 'Wrong email or password.';
    }
    if (/email not confirmed/i.test(m)) {
      return 'This email address is not confirmed yet. Ask the shop owner to confirm it.';
    }
    if (/network error/i.test(m)) {
      return 'Cannot reach the server. Check your internet connection and try again.';
    }
    return m || 'Sign in failed.';
  }

  function loadProfile(user) {
    return window.ANT.sb.from('profiles')
      .select('id, email, display_name, role, active')
      .eq('id', user.id)
      .single()
      .then(function (res) {
        if (res.error || !res.data) {
          return { blocked: true, reason: 'no_profile' };
        }
        if (res.data.active === false) {
          return { blocked: true, reason: 'inactive' };
        }
        // The granted areas are carried in the cached profile so a reload
        // paints the right menu before the second network read returns.
        return loadAreas(user.id).then(function (areas) {
          return {
            id: res.data.id,
            email: res.data.email || user.email,
            name: res.data.display_name || res.data.email || user.email,
            role: res.data.role,
            areas: areas,
            preview: false
          };
        });
      })
      .catch(function () {
        return { blocked: true, reason: 'lookup_failed' };
      });
  }

  function settle(profile) {
    if (profile.blocked) {
      window.ANT.sb.signOut();
      writeCache(null);
      if (profile.reason === 'inactive') {
        return Promise.reject(new Error('This account has been deactivated. Ask the shop owner.'));
      }
      return Promise.reject(new Error(
        'Your account has no profile yet, so no shop access can be granted. Ask the shop owner to set it up.'
      ));
    }
    writeCache(profile);
    return profile;
  }

  return {
    canAccess: canAccess,
    areasFor: areasFor,
    current: readCache,

    signIn: function (email, password) {
      if (!window.ANT.sb.configured()) {
        return Promise.reject(new Error(
          'No database is connected. Copy config.local.example.js to config.local.js and add your ' +
          'project URL and anon key, or use Preview mode below.'
        ));
      }
      if (!email || !password) {
        return Promise.reject(new Error('Enter both your email and password.'));
      }
      return window.ANT.sb.signIn(email, password).then(function (res) {
        if (res.error) throw new Error(friendly(res.error.message));
        if (!res.data) throw new Error('Sign in failed.');
        return loadProfile(res.data).then(settle);
      });
    },

    // Called on load. Re-checks the session against the server, because a
    // cached profile is only a paint optimisation and can be stale.
    restore: function () {
      var cached = readCache();

      if (!window.ANT.sb.configured()) {
        return Promise.resolve(cached && cached.preview ? cached : null);
      }

      return window.ANT.sb.currentUser().then(function (res) {
        if (res.error || !res.data) {
          writeCache(null);
          return null;
        }
        return loadProfile(res.data).then(function (profile) {
          if (profile.blocked) {
            window.ANT.sb.signOut();
            writeCache(null);
            return null;
          }
          writeCache(profile);
          return profile;
        });
      }).catch(function () {
        // Offline with a cached session: let them in, but only on the cached
        // role. The database will refuse anything they are not entitled to.
        return cached && !cached.preview ? cached : null;
      });
    },

    signOut: function () {
      writeCache(null);
      return window.ANT.sb.signOut();
    },

    previewSignIn: function (role) {
      var user = {
        id: 'preview-' + role,
        email: role === 'owner' ? 'owner@preview.local' : 'staff@preview.local',
        name: role === 'owner' ? 'Shop Owner' : 'Staff Member',
        role: role,
        preview: true
      };
      writeCache(user);
      return user;
    }
  };
})();

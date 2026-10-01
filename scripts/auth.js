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

  /* Access rules - the menu, and the router behind it.
   *
   * Read this before trusting it with anything sensitive.
   *
   * What the database enforces, in RLS, is the ROLE: `is_member()` admits any
   * active profile, and `is_owner()` is reserved for master data, Settings and
   * the staff_access table itself. That part is real and it is the security
   * boundary. A staff member cannot reach Settings or the price list even by
   * bypassing this file.
   *
   * What is decided HERE, and only here, is the narrower per-area grant: the
   * rows in staff_access that limit one tailor to the counters they actually
   * work. Those rows are not consulted by any policy on the data tables, and
   * no data table carries an area column for them to filter on. So a per-area
   * grant is a routing and menu convenience, NOT a data boundary. Someone
   * narrowed to a single area still has a valid session and a public anon key,
   * and can read every row through the REST API regardless of what the nav bar
   * shows them. Enforcing the grants for real means area-aware RLS policies on
   * the data tables; that is a deliberate, separate piece of work, not something
   * this file quietly achieves.
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

  /* Can the signed-in person read this area's data right now?
   *
   * A data module asks this before building a query, so a tailor the owner has
   * narrowed to one counter does not have the other counters' rows pulled into
   * their browser. Today the only consumer is the dashboard, which is the one
   * page that reads across areas by design; the other pages each read their own.
   *
   * It is a courtesy to the data, not a lock. RLS still admits is_member() on
   * these tables, the anon key is public, and the anon key is in the source
   * anyone loading the page already has. So this makes the app not *go looking*
   * for rows the person was not granted; it does not stop anyone who decides to
   * ask the API directly. Do not describe it to a shop owner as protection.
   *
   * An absent profile is treated as "not granted" rather than "granted". A
   * module that loads before sign-in has finished, or in preview mode with no
   * profile, would otherwise ask for everything.
   */
  function canRead(areaId) {
    var user = readCache();
    if (!user) return false;
    var hit = areasFor(user.role, user.areas).filter(function (a) {
      return a.id === areaId;
    })[0];
    return !!hit;
  }

  // The rows a person has been given. A read that fails or is filtered by RLS
  // yields an empty list, which means "leave them to their role" - never a
  // reason to keep a tailor out of the app.
  //
  // That is a deliberate choice with a known cost, and it is worth being precise
  // about: an empty list is the SAME value as a real "no rows" answer, so a
  // narrowed tailor whose grant read happens to fail is handed back their full
  // role. Since the grants only steer the menu (see the note above), the cost is
  // a wider nav bar for the length of one session, not data exposure. If the
  // grants ever become a data boundary, this is the line that has to change: a
  // failed read would have to deny, not default, and the two cases must be able
  // to tell each other apart.
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
    canRead: canRead,
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

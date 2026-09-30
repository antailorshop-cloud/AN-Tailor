/* AN TAILOR - minimal Supabase client.
 *
 * Written by hand rather than pulled from a CDN for three reasons:
 *   1. A shop phone on a weak or metered connection must not fail to boot
 *      because a third-party host is unreachable or blocked.
 *   2. The service worker can cache everything here, so the app opens offline
 *      and only the data calls need the network.
 *   3. No build step, no package manager, no 150KB dependency to audit.
 *
 * It implements only what this app needs - email/password auth plus PostgREST
 * queries - and mirrors the supabase-js call shape ({ data, error }) so the
 * rest of the app reads like ordinary Supabase code.
 *
 * The anon key is public by design. Row Level Security in the database, not
 * anything in this file, is what protects the data.
 */

window.ANT = window.ANT || {};

window.ANT.sb = (function () {
  var SESSION_KEY = 'anTailorSbSession';
  var REFRESH_MARGIN = 60; // seconds

  function config() {
    return window.ANT.config;
  }

  function root() {
    return String(config().supabaseUrl || '').replace(/\/+$/, '');
  }

  function configured() {
    return !!(config().supabaseUrl && config().supabaseAnonKey);
  }

  /* Session ---------------------------------------------------------- */

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeSession(value) {
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      return;
    }
  }

  function authHeaders(extra) {
    var out = {
      apikey: config().supabaseAnonKey,
      'Content-Type': 'application/json'
    };
    var s = readSession();
    if (s && s.access_token) {
      out.Authorization = 'Bearer ' + s.access_token;
    }
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        out[k] = extra[k];
      });
    }
    return out;
  }

  /* HTTP ------------------------------------------------------------- */

  function countFrom(range) {
    if (!range) return null;
    var slash = range.indexOf('/');
    if (slash === -1) return null;
    var total = parseInt(range.slice(slash + 1), 10);
    return isNaN(total) ? null : total;
  }

  function request(method, path, opts) {
    opts = opts || {};
    var url = root() + path + (opts.query ? '?' + opts.query : '');

    return fetch(url, {
      method: method,
      headers: authHeaders(opts.prefer ? { Prefer: opts.prefer } : null),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = null;
          }
        }
        if (!res.ok) {
          return {
            data: null,
            error: {
              message: (data && data.message) || res.statusText || 'Request failed',
              status: res.status,
              details: (data && data.details) || null,
              hint: (data && data.hint) || null
            }
          };
        }
        return {
          data: data,
          error: null,
          status: res.status,
          count: countFrom(res.headers.get('Content-Range'))
        };
      });
    }).catch(function (e) {
      return {
        data: null,
        error: { message: 'Network error: ' + (e && e.message ? e.message : e), status: 0 }
      };
    });
  }

  /* Query builder ----------------------------------------------------- */

  function encodeValue(v) {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return encodeURIComponent(String(v));
  }

  function Query(table) {
    this.table = table;
    this.mode = 'select';
    this.columns = '*';
    this.body = null;
    this.filters = [];
    this.orderList = [];
    this.limitTo = null;
    this.offsetTo = null;
    this.orExpr = null;
    // Named wantOne/wantMaybeOne rather than single/maybeSingle, because an
    // own property would shadow the single() and maybeSingle() methods.
    this.wantOne = false;
    this.wantMaybeOne = false;
    this.wantsCount = false;
    // Set by select() when it is called after insert/update, so the caller can
    // ask for the written rows back. It has to be a flag rather than a look at
    // this.columns, because columns defaults to '*' for a plain select.
    this.picksColumns = false;
  }

  Query.prototype.select = function (columns, opts) {
    this.columns = columns || '*';
    this.wantsCount = !!(opts && opts.count);
    this.picksColumns = true;
    return this;
  };

  Query.prototype.insert = function (rows) {
    this.mode = 'insert';
    this.body = Array.isArray(rows) ? rows : [rows];
    return this;
  };

  Query.prototype.update = function (values) {
    this.mode = 'update';
    this.body = values;
    return this;
  };

  Query.prototype.remove = function () {
    this.mode = 'delete';
    return this;
  };

  Query.prototype.delete = function () {
    return this.remove();
  };

  Query.prototype.eq = function (column, value) {
    this.filters.push(column + '=eq.' + encodeValue(value));
    return this;
  };

  Query.prototype.neq = function (column, value) {
    this.filters.push(column + '=neq.' + encodeValue(value));
    return this;
  };

  Query.prototype.is = function (column, value) {
    this.filters.push(column + '=is.' + encodeValue(value));
    return this;
  };

  Query.prototype.not = function (column, value) {
    this.filters.push(column + '=not.is.' + encodeValue(value));
    return this;
  };

  Query.prototype.in = function (column, values) {
    this.filters.push(column + '=in.(' + values.map(encodeValue).join(',') + ')');
    return this;
  };

  Query.prototype.ilike = function (column, pattern) {
    this.filters.push(column + '=ilike.' + encodeValue(pattern));
    return this;
  };

  Query.prototype.gte = function (column, value) {
    this.filters.push(column + '=gte.' + encodeValue(value));
    return this;
  };

  Query.prototype.lte = function (column, value) {
    this.filters.push(column + '=lte.' + encodeValue(value));
    return this;
  };

  // The value must be wrapped in parentheses. Without them PostgREST parses
  // "orname.ilike.x" as a column literally called "orname" and answers
  // "column customers.orname does not exist", which looks nothing like a
  // missing bracket. Wrapping here so no call site can get it wrong.
  Query.prototype.or = function (expr) {
    var e = String(expr);
    this.orExpr = (e.charAt(0) === '(') ? e : '(' + e + ')';
    return this;
  };

  Query.prototype.order = function (column, ascending) {
    this.orderList.push(column + '.' + (ascending === false ? 'desc' : 'asc'));
    return this;
  };

  Query.prototype.limit = function (n) {
    this.limitTo = n;
    return this;
  };

  Query.prototype.range = function (from, to) {
    this.offsetTo = from;
    this.limitTo = to - from + 1;
    return this;
  };

  Query.prototype.single = function () {
    this.wantOne = true;
    return this;
  };

  Query.prototype.maybeSingle = function () {
    this.wantMaybeOne = true;
    return this;
  };

  Query.prototype.execute = function () {
    var parts = [];
    var prefer = null;
    var wantsRow = this.wantOne || this.wantMaybeOne;

    if (this.mode === 'select') {
      parts.push('select=' + encodeURIComponent(this.columns));
      if (this.wantsCount) prefer = 'count=exact';
    } else if (this.mode === 'insert') {
      // PostgREST returns the inserted rows when asked to, and nothing when
      // not, so an insert that RLS discarded would otherwise be
      // indistinguishable from one that succeeded. return=minimal still answers
      // 201 when every row was filtered out, which is the trap.
      parts.push('select=*');
      // A caller that named columns after inserting wants the rows back. This
      // is how a multi-row insert is checked: single() cannot be used on one,
      // because PostgREST refuses to return an object for several rows.
      prefer = (wantsRow || this.picksColumns) ? 'return=representation' : 'return=minimal';
    } else if (this.mode === 'update' || this.mode === 'delete') {
      // Always ask for the affected rows. A blocked write comes back as an
      // empty list, which is the only reliable way to tell "denied" from
      // "nothing matched" - RLS does not raise an error.
      //
      // return=representation is required. Without it PostgREST defaults to
      // return=minimal and answers with an empty body, which is
      // indistinguishable from a row that RLS filtered out.
      parts.push('select=*');
      prefer = this.wantsCount ? 'return=representation,count=exact' : 'return=representation';
    }

    if (this.orExpr) parts.push('or=' + encodeURIComponent(this.orExpr));

    this.filters.forEach(function (f) {
      parts.push(f);
    });

    if (this.orderList.length) parts.push('order=' + encodeURIComponent(this.orderList.join(',')));
    if (this.limitTo != null) parts.push('limit=' + this.limitTo);
    if (this.offsetTo != null) parts.push('offset=' + this.offsetTo);

    var method = 'GET';
    if (this.mode === 'insert') method = 'POST';
    else if (this.mode === 'update') method = 'PATCH';
    else if (this.mode === 'delete') method = 'DELETE';

    return request(method, '/rest/v1/' + this.table, {
      query: parts.join('&'),
      body: (this.mode === 'select' || this.mode === 'delete') ? undefined : this.body,
      prefer: prefer
    }).then(function (res) {
      if (res.error) return res;
      if (wantsRow) {
        return {
          data: Array.isArray(res.data) ? res.data[0] || null : res.data,
          error: null,
          count: res.count
        };
      }
      return res;
    });
  };

  Query.prototype.then = function (onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  };

  /* Auth -------------------------------------------------------------- */

  function tokenRequest(grant, params) {
    return request('POST', '/auth/v1/token?grant_type=' + grant, { body: params })
      .then(function (res) {
        if (res.error) return res;
        var body = res.data || {};
        writeSession({
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: body.expires_at || (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : 0),
          user: body.user || null
        });
        return { data: body.user || null, error: null };
      });
  }

  var refreshPromise = null;

  function ensureFresh() {
    var s = readSession();
    if (!s || !s.access_token) return Promise.resolve(null);
    var now = Math.floor(Date.now() / 1000);
    if (s.expires_at && s.expires_at - now > REFRESH_MARGIN) return Promise.resolve(s);

    if (refreshPromise) return refreshPromise;

    refreshPromise = tokenRequest('refresh_token', { refresh_token: s.refresh_token })
      .then(function (res) {
        refreshPromise = null;
        if (res.error) {
          writeSession(null);
          return null;
        }
        return readSession();
      });

    return refreshPromise;
  }

  return {
    configured: configured,

    session: readSession,

    signIn: function (email, password) {
      return tokenRequest('password', { email: email, password: password });
    },

    signOut: function () {
      var s = readSession();
      writeSession(null);
      if (!s || !s.access_token) return Promise.resolve({ error: null });
      return request('POST', '/auth/v1/logout', {}).then(function () {
        return { error: null };
      });
    },

    currentUser: function () {
      return ensureFresh().then(function () {
        var s = readSession();
        if (!s || !s.user) return Promise.resolve({ data: null, error: null });
        return request('GET', '/auth/v1/user', {}).then(function (res) {
          if (res.data) {
            s.user = res.data;
            writeSession(s);
          }
          return res;
        });
      });
    },

    // Fires when the token is refreshed elsewhere or the session is lost.
    onAuthChange: function (handler) {
      window.addEventListener('storage', function (e) {
        if (e.key === SESSION_KEY) handler(readSession());
      });
    },

    from: function (table) {
      return new Query(table);
    }
  };
})();

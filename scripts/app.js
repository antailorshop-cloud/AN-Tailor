(function () {
  var cfg = window.ANT.config;
  var auth = window.ANT.auth;
  var keys = cfg.storageKeys;

  var el = {};
  var deferredInstall = null;

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast' + (kind ? ' toast-' + kind : '');
    node.textContent = message;
    el.toastStack.appendChild(node);
    window.setTimeout(function () {
      node.remove();
    }, 3600);
  }

  function money(value) {
    var n = Number(value || 0);
    return '₹' + n.toFixed(2);
  }

  /* Theme */

  function storedTheme() {
    try {
      var t = localStorage.getItem(keys.theme);
      if (t === 'light' || t === 'dark') return t;
    } catch (e) {}
    return 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var next = theme === 'dark' ? 'light' : 'dark';
    el.themeToggle.setAttribute('aria-label', 'Switch to ' + next + ' mode');
    el.themeIcon.innerHTML = theme === 'dark'
      ? '<path fill="currentColor" d="M12 4a1 1 0 0 1 0 2 6 6 0 1 0 6 6 1 1 0 0 1 2 0 8 8 0 1 1-8-8 1 1 0 0 1 0-2Z"/>'
      : '<path fill="currentColor" d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-13a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Zm0 15a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm14 0a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2h-1a1 1 0 0 1-1-1ZM6.3 6.3a1 1 0 0 1 1.4 0l.7.7a1 1 0 0 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4Zm9.3 9.3a1 1 0 0 1 1.4 0l.7.7a1 1 0 1 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4Zm2.1-9.3a1 1 0 0 1 0 1.4l-.7.7a1 1 0 1 1-1.4-1.4l.7-.7a1 1 0 0 1 1.4 0Zm-9.3 9.3a1 1 0 0 1 0 1.4l-.7.7a1 1 0 1 1-1.4-1.4l.7-.7a1 1 0 0 1 1.4 0Z"/>';
    try { localStorage.setItem(keys.theme, theme); } catch (e) {}
  }

  /* Routing */

  function allowedAreas() {
    var user = auth.current();
    if (!user) return [];
    return auth.areasFor(user.role, user.areas);
  }

  function currentAreaId() {
    var raw = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
    return raw || 'dashboard';
  }

  function renderNav() {
    var areas = allowedAreas();
    el.navTrack.innerHTML = '';

    areas.forEach(function (area) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item';
      btn.textContent = area.label;
      btn.dataset.area = area.id;
      btn.addEventListener('click', function () {
        location.hash = '#/' + area.id;
      });
      el.navTrack.appendChild(btn);
    });

    markActiveNav();
  }

  function markActiveNav() {
    var id = currentAreaId();
    Array.prototype.forEach.call(el.navTrack.children, function (btn) {
      if (btn.dataset.area === id) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  function pageHead(title, sub, actionsHtml) {
    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">' + escapeHtml(title) + '</h1>' +
        '<p class="page-head-sub">' + escapeHtml(sub) + '</p>' +
      '</div>' +
      (actionsHtml ? '<div class="page-head-actions">' + actionsHtml + '</div>' : '') +
    '</div>';
  }

  function phaseNote(phase, what) {
    return '<div class="phase-note">' +
      '<span><strong>Phase ' + phase + '.</strong> ' + escapeHtml(what) + '</span>' +
    '</div>';
  }

  function renderArea(area) {
    var descriptions = {
      customers: ['Customers', 'Search, add, edit, archive and view a customer\u2019s full history.', 6],
      measurements: ['Measurements', 'Per-customer measurements with history and copy-previous.', 7],
      orders: ['Orders', 'One order with multiple items, each with its own delivery date.', 8],
      bills: ['Bills', 'Generate a bill, print or save as PDF, share on WhatsApp, take UPI payment.', 10],
      payments: ['Payments', 'Record payments and see live balances and collection totals.', 9],
      resale: ['Resale Stock', 'Buy stock, track quantities and record resale orders.', 10],
      settings: ['Settings', 'Shop details, print size, WhatsApp messages, staff accounts and access.', 2]
    };

    var d = descriptions[area.id] || [area.label, '', area.phase];
    var ownerOnly = area.minRole === 'owner';

    return pageHead(d[0], d[1])
      + '<div class="ui-card">'
        + '<h2 class="ui-card-title">' + escapeHtml(d[0]) + ' &mdash; not built yet</h2>'
        + '<p class="ui-card-sub">This page is routed, permission-checked and styled. Its data work comes in the phase above.</p>'
        + '<div class="empty">'
          + '<div class="empty-title">Nothing to show yet</div>'
          + '<p class="empty-text">Once this area is built it will list records here, with search, filters and inline actions.</p>'
        + '</div>'
      + '</div>'
      + '<div style="margin-top:var(--gap)">'
        + phaseNote(d[2], ownerOnly
          ? 'Only the Owner role can open this area, and the database enforces that on the tables behind it - not just the menu.'
          : 'Available to both Owner and Staff roles.')
      + '</div>';
  }

  function renderRoute() {
    var user = auth.current();
    if (!user) return;

    var id = currentAreaId();

    // The account page is personal, not a shop section, so it is deliberately
    // not one of the config areas: every signed-in person has it, no per-area
    // grant can take it away, and it never appears as a tab. It is reached from
    // the profile menu (#/account).
    if (id === 'account') {
      el.main.innerHTML = window.ANT.account.mount();
      window.ANT.account.render();
      el.pageTitle.textContent = 'My profile';
      el.navTrack.scrollTop = 0;
      markActiveNav();
      el.main.focus();
      return;
    }

    var area = null;

    allowedAreas().forEach(function (a) {
      if (a.id === id) area = a;
    });

    if (!area) {
      el.main.innerHTML = pageHead('Not available', 'This area is not part of your access.')
        + '<div class="ui-card"><div class="empty">'
          + '<div class="empty-title">You do not have access here</div>'
          + '<p class="empty-text">Ask the shop owner if you need this section.</p>'
        + '</div></div>';
      el.pageTitle.textContent = 'Not available';
      markActiveNav();
      return;
    }

    var modules = {
      dashboard: window.ANT.dashboard,
      customers: window.ANT.customers,
      settings: window.ANT.settings,
      measurements: window.ANT.measurements,
      orders: window.ANT.orders,
      resale: window.ANT.resale,
      payments: window.ANT.payments,
      bills: window.ANT.bills
    };

    if (modules[area.id]) {
      el.main.innerHTML = modules[area.id].mount();
      modules[area.id].render();
      el.pageTitle.textContent = area.label;
      el.navTrack.scrollTop = 0;
      markActiveNav();
      el.main.focus();
      return;
    }

    el.main.innerHTML = renderArea(area);
    el.pageTitle.textContent = area.label;
    el.navTrack.scrollTop = 0;
    markActiveNav();
    el.main.focus();
  }

  /* Session UI */

  function applyUser(user) {
    if (!user) {
      el.shell.hidden = true;
      el.loginScreen.hidden = false;
      el.loginDev.hidden = window.ANT.isBackendConfigured();
      el.loginSub.textContent = window.ANT.isBackendConfigured()
        ? 'Sign in to continue'
        : 'No database connected yet';
      return;
    }

    el.loginScreen.hidden = true;
    el.shell.hidden = false;

    var initial = (user.name || user.email || 'A').charAt(0).toUpperCase();
    el.profileAvatar.textContent = initial;
    el.profileName.textContent = user.name || user.email;
    el.menuName.textContent = user.name || user.email;
    el.menuRole.textContent = (cfg.roles[user.role] || { label: user.role }).label;

    var isStaff = user.role !== 'owner';
    el.menuSettings.hidden = isStaff;

    renderNav();
    renderRoute();
  }

  /* Login panels: sign in, ask for a reset link, or set a new password after a
   * recovery link. Exactly one is on screen at a time. */
  function showLoginPanel(which) {
    if (el.loginForm) el.loginForm.hidden = which !== 'signin';
    if (el.loginForgot) el.loginForgot.hidden = which !== 'signin';
    if (el.resetForm) el.resetForm.hidden = which !== 'reset';
    if (el.recoverForm) el.recoverForm.hidden = which !== 'recover';
    if (el.loginDev) el.loginDev.hidden = which !== 'signin' || window.ANT.isBackendConfigured();
  }

  function message(id, text) {
    var node = byId(id);
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }

  // A recovery link puts a live token in the URL fragment. Take it out of the
  // address bar as soon as it has been read, so a reload or a screenshot cannot
  // carry a session the person did not mean to keep.
  function clearLinkHash() {
    try {
      if (location.hash && location.hash.indexOf('access_token=') !== -1) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (e) { /* the address bar is only tidied if the browser allows it */ }
  }

  function wireEvents() {
    el.themeToggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });

    window.addEventListener('hashchange', renderRoute);

    el.profileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = el.profileMenu.hidden;
      el.profileMenu.hidden = !open;
      el.profileBtn.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', function () {
      el.profileMenu.hidden = true;
      el.profileBtn.setAttribute('aria-expanded', 'false');
    });

    el.profileMenu.addEventListener('click', function (e) { e.stopPropagation(); });

    el.menuSettings.addEventListener('click', function () {
      el.profileMenu.hidden = true;
      location.hash = '#/settings';
    });

    el.menuAccount.addEventListener('click', function () {
      el.profileMenu.hidden = true;
      location.hash = '#/account';
    });

    el.menuSignOut.addEventListener('click', function () {
      auth.signOut();
      applyUser(null);
      toast('Signed out');
    });

    el.loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      el.loginError.hidden = true;
      var submit = el.loginForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      var email = el.loginEmail.value.trim();
      var password = el.loginPassword.value;
      auth.signIn(email, password)
        .then(function (user) {
          el.loginPassword.value = '';
          applyUser(user);
        })
        .catch(function (err) {
          el.loginError.textContent = err.message;
          el.loginError.hidden = false;
        })
        .then(function () {
          var again = el.loginForm.querySelector('button[type="submit"]');
          if (again) again.disabled = false;
        });
    });

    el.loginForgot.addEventListener('click', function () {
      message('loginError', '');
      message('resetError', '');
      message('resetNote', '');
      if (el.resetEmail && !el.resetEmail.value) el.resetEmail.value = el.loginEmail.value.trim();
      showLoginPanel('reset');
      if (el.resetEmail) el.resetEmail.focus();
    });

    el.resetBack.addEventListener('click', function () {
      message('resetError', '');
      message('resetNote', '');
      showLoginPanel('signin');
      el.loginEmail.focus();
    });

    el.resetForm.addEventListener('submit', function (e) {
      e.preventDefault();
      message('resetError', '');
      message('resetNote', '');
      var submit = el.resetForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      auth.requestReset(el.resetEmail.value.trim())
        .then(function () {
          message('resetNote', 'If an account uses that email, a reset link is on its way. ' +
            'Open the link on this device to choose a new password.');
        })
        .catch(function (err) {
          message('resetError', err.message);
        })
        .then(function () {
          if (submit) submit.disabled = false;
        });
    });

    el.recoverForm.addEventListener('submit', function (e) {
      e.preventDefault();
      message('recoverError', '');
      var next = el.recoverNew.value;
      var confirm = el.recoverConfirm.value;
      if (!next || next.length < 6) {
        message('recoverError', 'The new password must be at least 6 characters.');
        el.recoverNew.focus();
        return;
      }
      if (next !== confirm) {
        message('recoverError', 'The two new passwords do not match.');
        el.recoverConfirm.focus();
        return;
      }
      var submit = el.recoverForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      auth.completeReset(next)
        .then(function () {
          el.recoverNew.value = '';
          el.recoverConfirm.value = '';
          return auth.restore();
        })
        .then(function (user) {
          if (user) {
            toast('Your password was changed.');
            applyUser(user);
          } else {
            message('recoverError',
              'The password was saved, but the account could not be opened. Try signing in.');
            el.loginSub.textContent = 'Sign in to continue';
            showLoginPanel('signin');
          }
        })
        .catch(function (err) {
          message('recoverError', err.message);
        })
        .then(function () {
          if (submit) submit.disabled = false;
        });
    });

    Array.prototype.forEach.call(
      el.loginDev.querySelectorAll('[data-preview-role]'),
      function (btn) {
        btn.addEventListener('click', function () {
          applyUser(auth.previewSignIn(btn.dataset.previewRole));
        });
      }
    );

    el.shopTagline.textContent = cfg.tagline;

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      el.installBar.hidden = false;
    });

    el.installBtn.addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () {
        deferredInstall = null;
        el.installBar.hidden = true;
      });
    });

    el.installDismiss.addEventListener('click', function () {
      el.installBar.hidden = true;
    });
  }

  function boot() {
    el = {
      loginScreen: byId('loginScreen'),
      loginForm: byId('loginForm'),
      loginError: byId('loginError'),
      loginDev: byId('loginDev'),
      loginSub: byId('loginSub'),
      loginEmail: byId('loginEmail'),
      loginPassword: byId('loginPassword'),
      loginForgot: byId('loginForgot'),
      resetForm: byId('resetForm'),
      resetEmail: byId('resetEmail'),
      resetError: byId('resetError'),
      resetNote: byId('resetNote'),
      resetBack: byId('resetBack'),
      recoverForm: byId('recoverForm'),
      recoverNew: byId('recoverNew'),
      recoverConfirm: byId('recoverConfirm'),
      recoverError: byId('recoverError'),
      shell: byId('shell'),
      navTrack: byId('navTrack'),
      main: byId('main'),
      pageTitle: byId('pageTitle'),
      themeToggle: byId('themeToggle'),
      themeIcon: byId('themeIcon'),
      profileBtn: byId('profileBtn'),
      profileMenu: byId('profileMenu'),
      profileAvatar: byId('profileAvatar'),
      profileName: byId('profileName'),
      menuName: byId('menuName'),
      menuRole: byId('menuRole'),
      menuSettings: byId('menuSettings'),
      menuAccount: byId('menuAccount'),
      menuSignOut: byId('menuSignOut'),
      toastStack: byId('toastStack'),
      installBar: byId('installBar'),
      installBtn: byId('installBtn'),
      installDismiss: byId('installDismiss'),
      shopTagline: byId('shopTagline')
    };

    applyTheme(storedTheme());
    wireEvents();

    // Show the login screen immediately, then check the stored session against
    // the server. The cached role is only a paint optimisation, so the shell is
    // not revealed until the session has actually been verified.
    el.loginSub.textContent = 'Checking your session...';
    applyUser(null);

    // A password-reset email returns the person here with a recovery token in
    // the URL. That has to be handled before the usual session check: the token
    // is the only credential they have, and adopting it is what lets them set a
    // new password. A link that is stale or refused says so instead.
    var recovery = auth.recoveryFromUrl();
    if (recovery && (recovery.access_token || recovery.error)) {
      clearLinkHash();
      if (recovery.access_token) {
        auth.adoptRecovery(recovery);
        el.loginSub.textContent = 'Choose a new password';
        showLoginPanel('recover');
      } else {
        el.loginSub.textContent = window.ANT.isBackendConfigured()
          ? 'Sign in to continue'
          : 'No database connected yet';
        showLoginPanel('signin');
        message('loginError', 'That reset link has expired or was already used. Ask for a new one.');
      }
    } else {
      auth.restore().then(function (user) {
        el.loginSub.textContent = window.ANT.isBackendConfigured()
          ? 'Sign in to continue'
          : 'No database connected yet';
        applyUser(user);
      });
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {
        return null;
      });
    }

    checkForUpdate();
    warnIfStale();
  }

  // Tell the user when the app is running from the offline cache.
  //
  // The service worker serves cached code when the network fails, which is the
  // right thing to do for a shop with patchy signal. But a cached copy can be a
  // release or two old, and an old release misbehaves in ways that look like
  // bugs in the app rather than an out-of-date download. Saying so turns a
  // mystery into a two-second fix.
  function warnIfStale() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('message', function (event) {
      if (!event.data) return;

      if (event.data.type === 'stale') {
        showStaleBanner();
        return;
      }

      // A new service worker took over, meaning the cached files have just been
      // replaced. Reload so the open tab picks them up, unless the tailor is
      // part way through typing.
      if (event.data.type === 'updated') {
        var bar = byId('staleBar');
        if (bar) bar.remove();
        if (!isTyping()) window.location.reload();
        else window.ANT.toast('A new version is ready. Reload when you are ready.', 'success');
      }
    });

    if (!navigator.onLine) showStaleBanner();
  }

  function showStaleBanner() {
    if (byId('staleBar')) return;

    var bar = document.createElement('div');
    bar.id = 'staleBar';
    bar.className = 'stale-bar';
    bar.setAttribute('role', 'status');

    var text = document.createElement('span');
    text.textContent = navigator.onLine
      ? 'This is an older copy of the app. Reconnecting to the internet and reloading will update it.'
      : 'You are offline, so this is an older copy. Some things may not save.';

    var reload = document.createElement('button');
    reload.className = 'btn btn-sm btn-secondary';
    reload.textContent = 'Reload';
    reload.addEventListener('click', function () {
      window.location.reload();
    });

    bar.appendChild(text);
    bar.appendChild(reload);
    document.body.appendChild(bar);
  }

  // Ask the server whether a newer release exists.
  //
  // The app routes on the URL hash, so moving between areas never loads a page
  // and never re-checks the service worker. A tab left open across a deploy
  // therefore keeps running the code it started with, and a cached copy of a
  // script can survive indefinitely. Fetching config.js with the cache bypassed
  // and comparing the build stamp settles that without the user having to know
  // that a hard refresh exists.
  //
  // The reload is skipped while the login form is filled in, so a half-typed
  // password is never thrown away.
  function checkForUpdate() {
    if (!cfg.build) return;

    window.fetch('scripts/config.js', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.text() : ''; })
      .then(function (text) {
        if (!text) return;

        var m = /var BUILD\s*=\s*'([^']+)'/.exec(text);
        if (!m || m[1] === cfg.build) return;

        if (isTyping()) {
          window.ANT.toast('A new version is ready. Reload when you are ready.', 'success');
          return;
        }

        window.location.reload();
      })
      .catch(function () {
        // Offline or the check failed. The running code is still correct.
        return null;
      });
  }

  function isTyping() {
    var active = document.activeElement;
    if (!active) return false;
    var tag = (active.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  window.ANT.escapeHtml = escapeHtml;
  window.ANT.money = money;
  window.ANT.toast = toast;

  // Re-paint the shell from the signed-in person's profile. The account page
  // calls this after saving a name so the header and the menu follow immediately
  // without a reload. With no argument it reads the cached profile, which
  // auth.updateProfile has already refreshed.
  window.ANT.refreshUser = function (user) {
    applyUser(user || auth.current());
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* AN TAILOR - Account: a person's own name, contact details and password.
 *
 * This is the one page every signed-in person may use on themselves, and it
 * offers exactly three things they are allowed to change: their display name,
 * their phone and address, and their password. It cannot grant access, change a
 * role, or reach anyone else's row - and that is enforced by the database, not
 * by hiding buttons here. `profiles_update_self` limits the write to the row you
 * own and `block_role_escalation` refuses any change to role or active, so a
 * staff member who calls these functions directly is still refused by Postgres.
 *
 * Preview mode has no database row and no password, so it is told to sign in
 * rather than shown a form that could never save.
 */

window.ANT = window.ANT || {};

window.ANT.account = (function () {
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };
  var auth = function () { return window.ANT.auth; };

  var state = { busy: false };

  function me() {
    return window.ANT.auth.current() || {};
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function roleLabel(role) {
    var r = (window.ANT.config.roles || {})[role];
    return r ? r.label : (role || '');
  }

  function pageHead() {
    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">My profile</h1>' +
        '<p class="page-head-sub">Change your own name, phone and address, or your password. ' +
          'These are the only things you can change about yourself: your role and what you ' +
          'are allowed to open are the owner\u2019s to set.</p>' +
      '</div>' +
    '</div>';
  }

  function field(id, label, value, type, ac, hint) {
    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" type="' + esc(type || 'text') + '" ' +
        'value="' + esc(value) + '" autocomplete="' + esc(ac || 'off') + '" spellcheck="false">' +
      (hint ? '<p class="ui-hint">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  function readonlyField(id, label, value, hint) {
    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" value="' + esc(value) + '" disabled>' +
      (hint ? '<p class="ui-hint">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  function detailsCard(u) {
    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Your details</h2>' +
      '<p class="ui-hint">Your name is what the shop sees on screen beside your work.</p>' +
      '<form id="acctDetails" novalidate>' +
        '<div class="form-grid">' +
          field('acctName', 'Name', u.name || '', 'text', 'name',
            'The name shown on the dashboard and on anything you create.') +
          field('acctPhone', 'Phone', u.phone || '', 'tel', 'tel',
            'Optional. Kept with your account.') +
          field('acctAddress', 'Address', u.address || '', 'text', 'street-address',
            'Optional. Kept with your account.') +
          readonlyField('acctEmail', 'Login email', u.email || '',
            'This is how you sign in. Ask the owner if it needs to change.') +
          readonlyField('acctRole', 'Role', roleLabel(u.role),
            'Your role decides which sections you can open. Only the owner can change it.') +
        '</div>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Save details</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function passwordCard() {
    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Change password</h2>' +
      '<p class="ui-hint">Enter your current password, then the new one twice. ' +
        'Your current password is checked before anything changes.</p>' +
      '<form id="acctPassword" novalidate>' +
        '<div class="form-grid">' +
          field('acctCurrent', 'Current password', '', 'password', 'current-password', '') +
          field('acctNew', 'New password', '', 'password', 'new-password',
            'At least 6 characters.') +
          field('acctConfirm', 'Confirm new password', '', 'password', 'new-password', '') +
        '</div>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Change password</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function body() {
    var u = me();

    if (!u.id) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Not signed in</div>' +
        '<p class="empty-text">Sign in to change your details.</p>' +
      '</div></div>';
    }

    if (u.preview) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Preview mode</div>' +
        '<p class="empty-text">Preview accounts are not saved anywhere, so there are no ' +
          'details to change. Sign in with a real account to use this page.</p>' +
      '</div></div>';
    }

    return detailsCard(u) + passwordCard();
  }

  function paint() {
    var host = byId('accountView');
    if (!host) return;
    host.innerHTML = pageHead() + body();
    wire();
  }

  function saveDetails(e) {
    e.preventDefault();
    if (state.busy) return;

    var name = byId('acctName').value.trim();
    var phone = byId('acctPhone').value.trim();
    var address = byId('acctAddress').value.trim();
    if (!name) {
      toast('Enter a name to show on screen.', 'error');
      byId('acctName').focus();
      return;
    }

    state.busy = true;
    var btn = document.querySelector('#acctDetails button[type="submit"]');
    if (btn) btn.disabled = true;

    auth().updateProfile({ name: name, phone: phone, address: address })
      .then(function (user) {
        state.busy = false;
        toast('Your details were saved', 'success');
        // Re-paint the shell so the header name follows, and read this page fresh.
        if (window.ANT.refreshUser) window.ANT.refreshUser(user);
      })
      .catch(function (err) {
        state.busy = false;
        if (btn) btn.disabled = false;
        toast(err.message, 'error');
      });
  }

  function savePassword(e) {
    e.preventDefault();
    if (state.busy) return;

    var current = byId('acctCurrent').value;
    var next = byId('acctNew').value;
    var confirm = byId('acctConfirm').value;

    if (!current) {
      toast('Enter your current password.', 'error');
      byId('acctCurrent').focus();
      return;
    }
    if (!next || next.length < 6) {
      toast('The new password must be at least 6 characters.', 'error');
      byId('acctNew').focus();
      return;
    }
    if (next !== confirm) {
      toast('The two new passwords do not match.', 'error');
      byId('acctConfirm').focus();
      return;
    }

    state.busy = true;
    var btn = document.querySelector('#acctPassword button[type="submit"]');
    if (btn) btn.disabled = true;

    auth().changePassword(current, next)
      .then(function () {
        state.busy = false;
        byId('acctCurrent').value = '';
        byId('acctNew').value = '';
        byId('acctConfirm').value = '';
        if (btn) btn.disabled = false;
        toast('Your password was changed', 'success');
      })
      .catch(function (err) {
        state.busy = false;
        if (btn) btn.disabled = false;
        toast(err.message, 'error');
      });
  }

  function wire() {
    var details = byId('acctDetails');
    if (details) details.addEventListener('submit', saveDetails);

    var password = byId('acctPassword');
    if (password) password.addEventListener('submit', savePassword);
  }

  return {
    mount: function () {
      return '<div id="accountView"></div>';
    },

    render: function () {
      state.busy = false;
      paint();
    }
  };
})();

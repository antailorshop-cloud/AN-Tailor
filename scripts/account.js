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

  /* Accessible help: every hint gets an id and the input points at it with
   * aria-describedby, so a screen reader reads the help with the field rather
   * than after it. Validation messages are written into a role="alert" element
   * on the form, which is announced when it appears. */

  function field(id, label, value, type, ac, hint, described) {
    var hintId = id + 'Hint';
    var desc = (hint ? [hintId] : []).concat(described || []).join(' ');
    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" type="' + esc(type || 'text') + '" ' +
        'value="' + esc(value) + '" autocomplete="' + esc(ac || 'off') + '" spellcheck="false"' +
        (desc ? ' aria-describedby="' + desc + '"' : '') + '>' +
      (hint ? '<p class="ui-hint" id="' + hintId + '">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  function readonlyField(id, label, value, hint) {
    var hintId = id + 'Hint';
    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" value="' + esc(value) + '" disabled' +
        (hint ? ' aria-describedby="' + hintId + '"' : '') + '>' +
      (hint ? '<p class="ui-hint" id="' + hintId + '">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  /* A phone number is optional, and the shop writes them the way people write
   * them: +91 98111 22222, (022) 1234-5678, 98111-22222. So the rule accepts a
   * leading +, then digits and the usual separators, and judges by the count of
   * digits alone - 6 to 20, which fits every national and international number
   * without insisting on one country's shape. A letter anywhere is the one
   * thing that is refused. */
  function validPhone(value) {
    var v = String(value || '');
    if (!v) return true;
    if (!/^\+?[\d\s().-]+$/.test(v)) return false;
    var digits = v.replace(/\D/g, '');
    return digits.length >= 6 && digits.length <= 20;
  }

  /* A rough strength read, said in words rather than shown as a bar that needs
   * a legend. Length first, then whether the mix is varied. It advises; the only
   * hard rule is the six-character minimum, which the form enforces. */
  function strength(pw) {
    var s = String(pw || '');
    if (!s) return { label: '', level: 0 };
    var score = 0;
    if (s.length >= 6) score++;
    if (s.length >= 10) score++;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
    if (/\d/.test(s)) score++;
    if (/[^A-Za-z0-9]/.test(s)) score++;
    if (score <= 1) return { label: 'Weak', level: 1 };
    if (score <= 3) return { label: 'Fair', level: 2 };
    return { label: 'Strong', level: 3 };
  }

  function setError(id, message) {
    var el = byId(id);
    if (el) el.textContent = message || '';
  }

  function setBusy(formId, busy, label) {
    var btn = document.querySelector('#' + formId + ' button[type="submit"]');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? 'Saving\u2026' : label;
    }
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
        '<p class="ui-hint form-error" id="acctDetailsError" role="alert" aria-live="assertive"></p>' +
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
          '<div class="ui-field">' +
            '<label class="ui-label" for="acctNew">New password</label>' +
            '<input class="ui-input" id="acctNew" type="password" ' +
              'autocomplete="new-password" spellcheck="false" aria-describedby="acctNewHint acctStrength">' +
            '<p class="ui-hint" id="acctNewHint">At least 6 characters, and different ' +
              'from your current one.</p>' +
            '<p class="ui-hint pw-strength" id="acctStrength" aria-live="polite"></p>' +
          '</div>' +
          field('acctConfirm', 'Confirm new password', '', 'password', 'new-password', '') +
        '</div>' +
        '<p class="ui-hint form-error" id="acctPasswordError" role="alert" aria-live="assertive"></p>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Change password</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  /* The database is older than this page: the phone and address columns the
   * details form reads and writes are not there yet. Signing in still works, but
   * saving details cannot, so say so plainly and name the fix instead of letting
   * a save fail with a bare database message. The password still changes. */
  function schemaCard() {
    return '<div class="ui-card">' +
      '<div class="empty">' +
        '<div class="empty-title">Database update needed</div>' +
        '<p class="empty-text">This account\u2019s phone and address fields are not in the ' +
          'database yet, so they cannot be shown or saved. Ask the owner to run the latest ' +
          'database migration, then reload this page. Your password can still be changed below.' +
        '</p>' +
      '</div>' +
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

    if (u.schemaOutdated) {
      return schemaCard() + passwordCard();
    }

    return detailsCard(u) + passwordCard();
  }

  function paint() {
    var host = byId('accountView');
    if (!host) return;
    host.innerHTML = pageHead() + body();
    wire();
  }

  function updateStrength() {
    var el = byId('acctStrength');
    var input = byId('acctNew');
    if (!el || !input) return;
    var s = strength(input.value);
    el.textContent = s.label ? 'Strength: ' + s.label : '';
    el.className = 'ui-hint pw-strength' + (s.label ? ' is-' + s.label.toLowerCase() : '');
  }

  function saveDetails(e) {
    e.preventDefault();
    if (state.busy) return;
    setError('acctDetailsError', '');

    var name = byId('acctName').value.trim();
    var phone = byId('acctPhone').value.trim();
    var address = byId('acctAddress').value.trim();

    if (!name) {
      setError('acctDetailsError', 'Enter a name to show on screen.');
      toast('Enter a name to show on screen.', 'error');
      byId('acctName').focus();
      return;
    }
    if (!validPhone(phone)) {
      setError('acctDetailsError', 'Enter a phone number of at least 6 digits, or leave it blank.');
      toast('Enter a valid phone number.', 'error');
      byId('acctPhone').focus();
      return;
    }

    state.busy = true;
    setBusy('acctDetails', true, 'Save details');

    auth().updateProfile({ name: name, phone: phone, address: address })
      .then(function (user) {
        state.busy = false;
        setBusy('acctDetails', false, 'Save details');
        toast('Your details were saved', 'success');
        // Re-paint the shell so the header name follows, and read this page fresh.
        if (window.ANT.refreshUser) window.ANT.refreshUser(user);
      })
      .catch(function (err) {
        state.busy = false;
        setBusy('acctDetails', false, 'Save details');
        setError('acctDetailsError', err.message);
        toast(err.message, 'error');
      });
  }

  function savePassword(e) {
    e.preventDefault();
    if (state.busy) return;
    setError('acctPasswordError', '');

    var current = byId('acctCurrent').value;
    var next = byId('acctNew').value;
    var confirm = byId('acctConfirm').value;

    function refuse(fieldId, message) {
      setError('acctPasswordError', message);
      toast(message, 'error');
      byId(fieldId).focus();
    }

    if (!current) {
      refuse('acctCurrent', 'Enter your current password.');
      return;
    }
    if (!next || next.length < 6) {
      refuse('acctNew', 'The new password must be at least 6 characters.');
      return;
    }
    if (next === current) {
      refuse('acctNew', 'The new password must be different from your current password.');
      return;
    }
    if (next !== confirm) {
      refuse('acctConfirm', 'The two new passwords do not match.');
      return;
    }

    state.busy = true;
    setBusy('acctPassword', true, 'Change password');

    auth().changePassword(current, next)
      .then(function (out) {
        state.busy = false;
        setBusy('acctPassword', false, 'Change password');
        byId('acctCurrent').value = '';
        byId('acctNew').value = '';
        byId('acctConfirm').value = '';
        updateStrength();
        if (out && out.othersRevoked) {
          toast('Your password was changed, and other devices were signed out.', 'success');
        } else {
          toast('Your password was changed. Other devices could not be signed out automatically.',
            'warning');
        }
      })
      .catch(function (err) {
        state.busy = false;
        setBusy('acctPassword', false, 'Change password');
        setError('acctPasswordError', err.message);
        toast(err.message, 'error');
      });
  }

  function wire() {
    var details = byId('acctDetails');
    if (details) details.addEventListener('submit', saveDetails);

    var password = byId('acctPassword');
    if (password) password.addEventListener('submit', savePassword);

    var newPw = byId('acctNew');
    if (newPw) newPw.addEventListener('input', updateStrength);
    updateStrength();
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

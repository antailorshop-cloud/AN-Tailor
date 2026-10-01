/* AN TAILOR - Settings: dress types, prices and shop details.
 *
 * Dress types and prices are master data. Every order line needs a dress type
 * and a price, so nothing downstream can be created until these hold real
 * values. Shop details (name and the UPI id a bill pays into) live in the
 * key/value shop_settings table and are read by the bills page when it prints.
 *
 * Read access is open to every signed-in user, because staff must be able to
 * see a price while taking an order, and bills read the shop UPI id to draw the
 * payment QR. Writes are the owner's alone, and that is enforced by the
 * database policies `prices_write_owner`, `dress_types_write_owner` and
 * `settings_write_owner`, not by this file. A staff member who finds a way to
 * call these functions anyway is refused by Postgres.
 *
 * Rows are retired with `status` rather than deleted. A price or dress type
 * that appears on a past order must keep its meaning, otherwise old bills stop
 * making sense.
 */

window.ANT = window.ANT || {};

window.ANT.settings = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };

  var CATEGORIES = ['Gents', 'Ladies'];
  var GROUPS = ['TAILORING', 'SERVICE', 'RESALE'];

  // Bill payment uses the first three. The last is the wording of the WhatsApp
  // bill message; an empty value means the standard wording, which is why it is
  // kept here beside the UPI id rather than hardcoded in the message builder.
  // The two print sizes are paper choices for two different documents, and they
  // are kept apart because a shop that prints receipts two-to-a-sheet almost
  // always still wants a full A4 bill.
  var SHOP_KEYS = ['shop_name', 'upi_id', 'upi_payee_name', 'wa_bill_message',
    'wa_reminder_message', 'wa_ready_message', 'bill_print_size',
    'receipt_print_size'];

  var state = {
    tab: 'dress',
    search: '',
    dressRows: [],
    priceRows: [],
    shop: { shop_name: '', upi_id: '', upi_payee_name: '', wa_bill_message: '',
      wa_reminder_message: '', wa_ready_message: '', bill_print_size: '', receipt_print_size: '' },
    staff: { rows: [], access: {}, loading: false, error: null },
    loading: false,
    error: null,
    form: null   // null = closed, {kind:'dress'|'price', row:{}|null}
  };

  var searchTimer = null;

  function me() {
    return window.ANT.auth.current() || {};
  }

  function isOwner() {
    return me().role === 'owner';
  }

  // The day-to-day areas a person can be narrowed to. Settings is not in the
  // list because access to it follows the role: no staff_access row can hand it
  // out, so offering a box for it would be a box that never takes effect.
  function grantableAreas() {
    return (window.ANT.config.areas || []).filter(function (a) {
      return a.access && a.minRole !== 'owner';
    });
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /* Loading ------------------------------------------------------------ */

  function load() {
    state.loading = true;
    if (state.search === '') paint();

    var d = sb().from('dress_types').select('*')
      .order('category', true).order('dress_type', true);

    var p = sb().from('prices').select('*')
      .order('group_name', true).order('item', true).order('option', true);

    var s = sb().from('shop_settings').select('key,value');

    return Promise.all([d, p, s]).then(function (both) {
      state.loading = false;

      var first = both[0].error
        ? both[0]
        : (both[1].error ? both[1] : (both[2].error ? both[2] : null));

      if (first) {
        state.error = first.message;
      } else {
        state.error = null;
        state.dressRows = both[0].data || [];
        state.priceRows = both[1].data || [];
        applyShop(both[2].data || []);
      }
      paint();
    });
  }

  // shop_settings is a key/value table. Only the keys the bill uses are kept;
  // anything else a hand-edit left in the table is ignored rather than shown.
  function applyShop(rows) {
    var shop = { shop_name: '', upi_id: '', upi_payee_name: '', wa_bill_message: '',
      wa_reminder_message: '', wa_ready_message: '', bill_print_size: '', receipt_print_size: '' };
    rows.forEach(function (row) {
      if (SHOP_KEYS.indexOf(row.key) !== -1) {
        shop[row.key] = String(row.value == null ? '' : row.value);
      }
    });
    state.shop = shop;
  }

  /* Helpers ------------------------------------------------------------ */

  function matches(hay, needle) {
    return String(hay == null ? '' : hay).toLowerCase().indexOf(needle) !== -1;
  }

  function needle() {
    return String(state.search || '').trim().toLowerCase();
  }

  function money(v) {
    var n = Number(v || 0);
    return 'â‚¹' + (Math.round(n * 100) / 100).toLocaleString('en-IN');
  }

  // Prices are numeric(12,2). A blank field means zero rather than an error,
  // because a price that is not known yet is genuinely zero at this stage.
  function parseAmount(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/,/g, '');
    if (s === '') return 0;
    var n = Number(s);
    return isNaN(n) || n < 0 ? null : Math.round(n * 100) / 100;
  }

  /* View --------------------------------------------------------------- */

  function paint() {
    var host = byId('settingsView');
    if (!host) return;
    host.innerHTML = pageHead() + tabs() + (state.form ? formHtml() : '') + body();
    wire();
  }

  function pageHead() {
    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">Settings</h1>' +
        '<p class="page-head-sub">Dress types, prices, the shop UPI ID and the WhatsApp wording. ' +
          'Staff can read these; only the Owner can change them.</p>' +
      '</div>' +
    '</div>';
  }

  function tabs() {
    return '<div class="set-tabs">' +
      '<button class="set-tab' + (state.tab === 'dress' ? ' is-active' : '') + '" data-set-tab="dress">Dress types</button>' +
      '<button class="set-tab' + (state.tab === 'price' ? ' is-active' : '') + '" data-set-tab="price">Prices</button>' +
      '<button class="set-tab' + (state.tab === 'shop' ? ' is-active' : '') + '" data-set-tab="shop">Shop &amp; UPI</button>' +
      '<button class="set-tab' + (state.tab === 'whatsapp' ? ' is-active' : '') + '" data-set-tab="whatsapp">WhatsApp</button>' +
      '<button class="set-tab' + (state.tab === 'staff' ? ' is-active' : '') + '" data-set-tab="staff">Staff</button>' +
    '</div>';
  }

  function searchBox(placeholder) {
    return '<div class="cust-toolbar">' +
      '<input class="ui-input cust-search" id="setSearch" type="search" ' +
        'placeholder="' + esc(placeholder) + '" value="' + esc(state.search) + '" ' +
        'autocomplete="off" spellcheck="false">' +
      '<span class="cust-count">' + esc(countLabel()) + '</span>' +
      (isOwner() && !state.form
        ? '<button class="btn btn-primary" id="setNew">' +
            (state.tab === 'dress' ? '+ New dress type' : '+ New price') +
          '</button>'
        : '') +
    '</div>';
  }

  function countLabel() {
    var n = state.tab === 'dress' ? filteredDress().length : filteredPrices().length;
    var what = state.tab === 'dress' ? 'dress type' : 'price';
    if (state.loading) return 'Loading...';
    if (state.search) return n + ' ' + what + (n === 1 ? '' : 's') + ' for "' + state.search + '"';
    return n + ' ' + what + (n === 1 ? '' : 's');
  }

  function filteredDress() {
    var n = needle();
    if (!n) return state.dressRows;
    return state.dressRows.filter(function (r) {
      return matches(r.category, n) || matches(r.dress_type, n);
    });
  }

  function filteredPrices() {
    var n = needle();
    if (!n) return state.priceRows;
    return state.priceRows.filter(function (r) {
      return matches(r.group_name, n) || matches(r.item, n) || matches(r.option, n);
    });
  }

  function body() {
    if (state.error) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Could not load settings</div>' +
        '<p class="empty-text">' + esc(state.error) + '</p>' +
      '</div></div>';
    }
    if (state.tab === 'shop') return shopPanel();
    if (state.tab === 'whatsapp') return whatsappPanel();
    if (state.tab === 'staff') return staffPanel();
    return state.tab === 'dress' ? dressPanel() : pricePanel();
  }

  function dressPanel() {
    var rows = filteredDress();
    var head = searchBox('Search dress types');

    if (state.loading && !rows.length) {
      return head + '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    if (!rows.length) {
      return head + '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">' +
          (state.search ? 'No dress type matches that search' : 'No dress types yet') +
        '</div>' +
        '<p class="empty-text">' +
          (state.search
            ? 'Try part of a category or a name.'
            : 'Add the types this shop stitches, such as Shirt or Blouse.') +
        '</p>' +
      '</div></div>';
    }

    // Grouped by category, because the shop thinks in "what we make for gents"
    // rather than in one flat list of nineteen names.
    var groups = CATEGORIES.map(function (cat) {
      return { category: cat, items: rows.filter(function (r) { return r.category === cat; }) };
    }).filter(function (g) { return g.items.length; });

    // Anything with an unexpected category still has to be visible, or a typo
    // in the data would silently hide a garment the shop offers.
    var known = CATEGORIES.join('|');
    var others = rows.filter(function (r) { return CATEGORIES.indexOf(r.category) === -1; });
    if (others.length) groups.push({ category: 'Other', items: others });

    return head + '<div class="set-groups">' + groups.map(function (g) {
      return '<section class="ui-card">' +
        '<h2 class="set-group-title"><span class="chip">' + esc(g.category) + '</span>' +
          '<span>' + g.items.length + '</span>' +
        '</h2>' +
        '<div class="set-chip-list">' + g.items.map(function (r) {
          return '<span class="set-chip">' + esc(r.dress_type) +
            (isOwner()
              ? '<button class="btn btn-quiet" data-set-edit="' + esc(r.id) + '" ' +
                  'aria-label="Edit ' + esc(r.dress_type) + '">Edit</button>' +
                '<button class="btn btn-quiet" data-set-del="' + esc(r.id) + '" ' +
                  'aria-label="Delete ' + esc(r.dress_type) + '">Delete</button>'
              : '') +
          '</span>';
        }).join('') + '</div>' +
      '</section>';
    }).join('') + '</div>';
  }

  function pricePanel() {
    var rows = filteredPrices();

    var head = searchBox('Search item, option or group');

    if (state.loading && !rows.length) {
      return head + '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    if (!rows.length) {
      return head + '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">' +
          (state.search ? 'No price matches that search' : 'No prices yet') +
        '</div>' +
        '<p class="empty-text">' +
          (state.search
            ? 'Try part of an item name.'
            : 'Add what the shop charges for: tailoring variants, services and resale stock.') +
        '</p>' +
      '</div></div>';
    }

    // Grouped by TAILORING / SERVICE / RESALE. A flat list of seventeen rows
    // mixes a per-garment charge with a one-off service and a resale item,
    // which are different kinds of thing to compare.
    var groups = GROUPS.map(function (g) {
      return { group: g, items: rows.filter(function (r) { return r.group_name === g; }) };
    }).filter(function (g) { return g.items.length; });

    var others = rows.filter(function (r) { return GROUPS.indexOf(r.group_name) === -1; });
    if (others.length) groups.push({ group: 'Other', items: others });

    return head + '<div class="set-groups">' + groups.map(function (g) {
      return '<section class="ui-card">' +
        '<h2 class="set-group-title"><span class="chip">' + esc(g.group) + '</span>' +
          '<span>' + g.items.length + '</span>' +
        '</h2>' +
        '<div class="table-wrap"><table class="ui-table">' +
          '<thead><tr><th>Code</th><th>Item</th><th>Option</th><th class="num">Price</th><th></th></tr></thead>' +
          '<tbody>' + g.items.map(priceRow).join('') + '</tbody>' +
        '</table></div>' +
      '</section>';
    }).join('') + '</div>';
  }

  function priceRow(r) {
    var zero = Number(r.price || 0) === 0;
    var extra = Number(r.extra_charge || 0);

    return '<tr>' +
      '<td class="cust-code">' + esc(r.code) + '</td>' +
      '<td class="cust-name">' + esc(r.item) + '</td>' +
      '<td>' + esc(r.option || 'â€”') + '</td>' +
      '<td class="num set-price-cell">' +
        '<span' + (zero ? ' class="set-price-zero"' : '') + '>' + esc(money(r.price)) + '</span>' +
        (extra !== 0 ? '<span class="set-extra">+ ' + esc(money(extra)) + ' extra</span>' : '') +
      '</td>' +
      '<td class="set-row-actions">' +
        (isOwner()
          ? '<button class="btn btn-sm btn-secondary" data-set-edit="' + esc(r.id) + '">Edit</button>' +
            '<button class="btn btn-sm btn-danger" data-set-del="' + esc(r.id) + '">Delete</button>'
          : '') +
      '</td>' +
    '</tr>';
  }

  /* Shop & UPI --------------------------------------------------------- */

  function shopField(id, label, value, hint) {
    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" value="' + esc(value) + '" autocomplete="off">' +
      (hint ? '<p class="ui-hint">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  /* One paper picker, used twice. The wording differs because the sheet means
   * something different for a bill than for a slip, and the size only ever
   * affects how the document is laid out - never a figure printed on it. */
  function printSizeField(id, label, current, kind, hint) {
    var picked = window.ANT.printsize.normalize(current,
      kind === 'receipt' ? window.ANT.printsize.RECEIPT_DEFAULT : window.ANT.printsize.DEFAULT);

    var options = window.ANT.printsize.SIZES.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (s.key === picked ? ' selected' : '') + '>' +
        esc(window.ANT.printsize.label(s.key, kind)) + '</option>';
    }).join('');

    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<select class="ui-input" id="' + id + '">' + options + '</select>' +
      '<p class="ui-hint">' + esc(hint) + '</p>' +
    '</div>';
  }

  function shopPanel() {
    if (state.loading) {
      return '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    var s = state.shop;
    var upi = String(s.upi_id || '');

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Shop &amp; UPI</h2>' +
      '<p class="ui-hint">These are printed on bills. The UPI ID is where a customer\'s ' +
        'money lands, so a bill with a wrong one still looks normal - check it carefully.</p>' +
      '<form id="shopForm" novalidate>' +
        '<div class="form-grid">' +
          shopField('shopName', 'Shop name', s.shop_name, 'Shown on the bill and used as the UPI payee when no payee name is set.') +
          shopField('shopUpi', 'UPI ID', upi, 'Like antailor@okhdfcbank. Printed as a QR on any bill with money still due.') +
          shopField('shopPayee', 'UPI payee name', s.upi_payee_name, 'The name the customer sees in their UPI app.') +
          shopField('shopConfirm', 'Confirm UPI ID', '', 'Type the new UPI ID again, but only when you change an existing one.') +
          printSizeField('shopPrintSize', 'Bill print size', s.bill_print_size, 'bill',
            'Lays out the printed bill only; it never changes a figure. The A4 sheet ' +
            'option prints one A5 bill on the left half and leaves the right half ' +
            'blank to cut off and reuse.') +
          printSizeField('shopReceiptSize', 'Receipt print size', s.receipt_print_size, 'receipt',
            'The slip printed from the Payments page. It defaults to A5, because a ' +
            'full sheet for a small cash payment is paper wasted.') +
        '</div>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Save shop settings</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function saveShop() {
    var name = byId('shopName').value.trim();
    var upiIn = window.ANT.upi.normalizeVpa(byId('shopUpi').value);
    var payee = byId('shopPayee').value.trim();
    var confirm = window.ANT.upi.normalizeVpa(byId('shopConfirm').value);
    var printSize = window.ANT.printsize.normalize(byId('shopPrintSize').value);
    var receiptSize = window.ANT.printsize.normalize(byId('shopReceiptSize').value);

    var problem = window.ANT.upi.vpaProblem(upiIn);
    if (problem) {
      toast(problem, 'error');
      byId('shopUpi').focus();
      return;
    }

    // Changing a live UPI id moves the account customers pay into, and a bill
    // with the wrong id looks exactly like a correct one, so an existing id may
    // only be replaced by typing the new one a second time. Clearing is allowed
    // without the echo: an empty id turns the QR off rather than misdirecting a
    // payment.
    var current = window.ANT.upi.normalizeVpa(state.shop.upi_id);
    if (current && upiIn && upiIn !== current && confirm !== upiIn) {
      toast('This changes the account customers pay from "' + current + '". ' +
        'Type the new UPI ID in the confirm box to go ahead.', 'error');
      byId('shopConfirm').focus();
      return;
    }

    Promise.all([
      putSetting('shop_name', name),
      putSetting('upi_id', upiIn),
      putSetting('upi_payee_name', payee),
      putSetting('bill_print_size', printSize),
      putSetting('receipt_print_size', receiptSize)
    ]).then(function (results) {
      var bad = results.filter(function (r) { return r && r.error; })[0];
      if (bad) {
        toast(bad.error.message, 'error');
        return;
      }
      toast('Shop settings saved', 'success');
      load();
    });
  }

  // shop_settings is one row per key. An update that matches nothing means the
  // key was never stored (or RLS filtered it), so the row is inserted instead.
  function putSetting(key, value) {
    return sb().from('shop_settings')
      .update({ value: value })
      .eq('key', key)
      .select('key')
      .then(function (res) {
        if (res.error) return res;
        if (res.data && res.data.length) return res;
        return sb().from('shop_settings').insert({ key: key, value: value }).select('key');
      });
  }

  /* WhatsApp ------------------------------------------------------------ */

  // The tokens the message builder understands, written out so the owner can
  // see what they may type. The list comes from the module that does the
  // replacing, so a token can never be advertised here and unknown there.
  function tokenLegend() {
    var tokens = (window.ANT.whatsapp && window.ANT.whatsapp.TOKENS) || [];

    return '<ul class="wa-tokens">' + tokens.map(function (t) {
      return '<li><code>' + esc(t[0]) + '</code> ' + esc(t[1]) + '</li>';
    }).join('') + '</ul>';
  }

  /* One message box, with the same save-and-clear-back-to-default rule for
   * each: the box always shows what the customer will actually read, and
   * clearing it is the way back to the standard wording. */
  function waBox(id, label, savedKey, fallback, hint) {
    var standard = (window.ANT.whatsapp && window.ANT.whatsapp[fallback]) || '';
    var saved = String(state.shop[savedKey] || '').trim();

    return '<div class="ui-field">' +
      '<label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<textarea class="ui-textarea" id="' + id + '" rows="8" spellcheck="false">' +
        esc(saved || standard) + '</textarea>' +
      '<p class="ui-hint">' + esc(hint) + ' Clear the box and save to go back to the standard wording.</p>' +
    '</div>';
  }

  function whatsappPanel() {
    if (state.loading) {
      return '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    // An unset template shows the standard wording in the box rather than a
    // blank one, for the same reason on all three.
    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">WhatsApp messages</h2>' +
      '<p class="ui-hint">These are the messages the shop sends. Placeholders in curly ' +
        'brackets are filled in from the record; everything else is sent as typed.</p>' +
      '<form id="waForm" novalidate>' +
        waBox('waBillMessage', 'Bill message', 'wa_bill_message', 'DEFAULT_BILL',
          'Sent from the Bills page.') +
        waBox('waReminderMessage', 'Payment reminder', 'wa_reminder_message', 'DEFAULT_REMINDER',
          'Sent from a bill that still owes money.') +
        waBox('waReadyMessage', 'Order ready', 'wa_ready_message', 'DEFAULT_READY',
          'Sent from an order that is marked Ready.') +
        tokenLegend() +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Save WhatsApp messages</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function saveWhatsApp() {
    var bill = byId('waBillMessage').value.trim();
    var reminder = byId('waReminderMessage').value.trim();
    var ready = byId('waReadyMessage').value.trim();

    Promise.all([
      putSetting('wa_bill_message', bill),
      putSetting('wa_reminder_message', reminder),
      putSetting('wa_ready_message', ready)
    ]).then(function (results) {
      var bad = results.filter(function (r) { return r && r.error; })[0];
      if (bad) {
        toast(bad.error.message, 'error');
        return;
      }
      toast('WhatsApp messages saved', 'success');
      load();
    });
  }

  /* Staff --------------------------------------------------------------- */

  // Written in place of a real area name to say "this person was narrowed to
  // nothing". It has to exist, because the rule in auth.js reads no rows as "no
  // narrowing", and a tailor the owner has deliberately locked out would
  // otherwise be handed every area back the moment the last box was unticked.
  var NO_AREA = 'NONE';

  function loadStaff() {
    state.staff.loading = true;
    state.staff.error = null;
    paint();

    var p = sb().from('profiles')
      .select('id, email, display_name, role, active')
      .order('display_name', true);

    var a = sb().from('staff_access').select('user_id, area');

    return Promise.all([p, a]).then(function (both) {
      state.staff.loading = false;

      // An owner can read every profile and every access row. Anything else is
      // a genuine failure, and saying so beats showing an empty staff list that
      // looks like a shop with no employees.
      var first = both[0].error ? both[0] : (both[1].error ? both[1] : null);
      if (first) {
        state.staff.error = first.message;
        paint();
        return;
      }

      var byUser = {};
      (both[1].data || []).forEach(function (r) {
        var list = byUser[r.user_id] || (byUser[r.user_id] = []);
        list.push(String(r.area || ''));
      });

      state.staff.rows = both[0].data || [];
      state.staff.access = byUser;
      paint();
    });
  }

  // The areas a person can actually open: the role narrowed by their rows.
  //
  // This asks auth.js rather than repeating the rule. The two were written out
  // separately and, while they agree for the two roles and eight areas that exist
  // today, nothing kept them agreeing: this copy tested minRole against a
  // hardcoded 'owner' and allowlisted 'owner'/'staff' by name instead of using the
  // rank table, so a third role would have made this screen tick boxes the menu
  // then refused. There is now one implementation of the rule and the Staff screen
  // cannot disagree with the nav bar.
  function effectiveAreas(role, rows) {
    return window.ANT.auth.areasFor(role, rows).map(function (a) { return a.access; });
  }

  function staffRow(r) {
    var mine = r.id === me().id;
    var rows = state.staff.access[r.id] || [];
    var open = effectiveAreas(r.role, rows);
    var off = r.active === false;

    var roleOptions = ['owner', 'staff'].map(function (role) {
      return '<option value="' + role + '"' + (r.role === role ? ' selected' : '') + '>' +
        window.ANT.config.roles[role].label + '</option>';
    }).join('');

    // The owner is left alone on their own row. Narrowing or deactivating the
    // person reading the screen is the one mistake that cannot be undone from
    // inside the app, so those controls are simply not drawn.
    // The chip says "on" in its markup rather than through :has(), because a
    // shop phone may be on a browser too old for that and the box would still
    // be ticked with nothing to show it.
    var boxes = grantableAreas().map(function (a) {
      var on = open.indexOf(a.access) !== -1;
      return '<label class="staff-area ' + (on ? 'is-on ' : '') + (mine ? 'is-locked' : '') + '">' +
        '<input type="checkbox" data-staff-area="' + esc(a.access) + '" ' +
          'data-staff-user="' + esc(r.id) + '"' + (on ? ' checked' : '') +
          (mine ? ' disabled' : '') + '>' +
        '<span>' + esc(a.label) + '</span>' +
      '</label>';
    }).join('');

    return '<section class="ui-card staff-card' + (off ? ' is-off' : '') + '">' +
      '<div class="staff-head">' +
        '<div>' +
          '<h2 class="ui-card-title">' + esc(r.display_name || r.email || '(no name)') +
            (mine ? ' <span class="chip">you</span>' : '') +
          '</h2>' +
          '<p class="ui-hint">' + esc(r.email || '') +
            (off ? ' &middot; deactivated, cannot sign in' : '') + '</p>' +
        '</div>' +
        (mine ? '' :
          '<div class="staff-actions">' +
            '<button class="btn btn-sm ' + (off ? 'btn-secondary' : 'btn-danger') + '" ' +
              'data-staff-active="' + esc(r.id) + '">' +
              (off ? 'Reactivate' : 'Deactivate') + '</button>' +
          '</div>') +
      '</div>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="staffRole-' + esc(r.id) + '">Role</label>' +
        '<select class="ui-input" id="staffRole-' + esc(r.id) + '" ' +
          'data-staff-role="' + esc(r.id) + '"' + (mine ? ' disabled' : '') + '>' +
          roleOptions + '</select>' +
      '</div>' +
      '<div class="ui-field">' +
        '<span class="ui-label">Can open</span>' +
        '<div class="staff-areas">' + boxes + '</div>' +
        '<p class="ui-hint">' + (mine
          ? 'Your own row is left as it is, so the shop cannot be locked out of its own settings.'
          : 'Unticking everything stops this person opening any page. An owner always keeps every area, which is why Settings is not in the list.') +
        '</p>' +
      '</div>' +
    '</section>';
  }

  function staffPanel() {
    if (!isOwner()) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Only the Owner can see this</div>' +
        '<p class="empty-text">Ask the shop owner to change who works where.</p>' +
      '</div></div>';
    }

    if (state.staff.error) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Could not load the staff list</div>' +
        '<p class="empty-text">' + esc(state.staff.error) + '</p>' +
      '</div></div>';
    }

    var rows = state.staff.rows;

    var head = '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Staff</h2>' +
      '<p class="ui-hint">Who may sign in, what they may open, and whether they still can. ' +
        'Accounts are made in the Supabase dashboard for now; once one exists it appears here. ' +
        'A deactivated person is refused at sign in and cannot be reached by writing to the ' +
        'database directly either.</p>' +
    '</div>';

    if (state.staff.loading && !rows.length) {
      return head + '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    if (!rows.length) {
      return head + '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">No accounts yet</div>' +
        '<p class="empty-text">Add one in the Supabase dashboard under Authentication, then sign ' +
          'in once so it gets a profile. It will be listed here.</p>' +
      '</div></div>';
    }

    return head + rows.map(staffRow).join('');
  }

  function setRole(id, role) {
    var found = state.staff.rows.filter(function (r) { return r.id === id; })[0];
    if (!found || found.role === role) return Promise.resolve();

    // Set first and repaint, so a second change is measured against this one.
    found.role = role;
    paint();

    return sb().from('profiles')
      .update({ role: role })
      .eq('id', id)
      .select('id')
      .then(guardEmpty)
      .then(function (res) {
        if (res.error) {
          toast(res.error.message, 'error');
          loadStaff();
          return;
        }
        toast((role === 'owner' ? 'Promoted' : 'Made staff') + ': ' + nameOf(found), 'success');
      });
  }

  function setActive(id) {
    var found = state.staff.rows.filter(function (r) { return r.id === id; })[0];
    if (!found) return Promise.resolve();

    var next = found.active === false;

    // Turning the last working owner off would leave the shop with nobody who
    // can undo it, so it is refused here as well as in the database.
    if (!next && found.role === 'owner' && owners().length <= 1) {
      toast('This is the only active Owner. Promote somebody else first.', 'error');
      paint();
      return Promise.resolve();
    }

    found.active = next;
    paint();

    return sb().from('profiles')
      .update({ active: next })
      .eq('id', id)
      .select('id')
      .then(guardEmpty)
      .then(function (res) {
        if (res.error) {
          toast(res.error.message, 'error');
          loadStaff();
          return;
        }
        toast(nameOf(found) + (next ? ' can sign in again' : ' can no longer sign in'), 'success');
      });
  }

  function owners() {
    return state.staff.rows.filter(function (r) {
      return r.role === 'owner' && r.active !== false;
    });
  }

  function nameOf(r) {
    return r.display_name || r.email || '(no name)';
  }

  // One write per change, and the row that keeps "no access" true goes in first.
  // Deleting the last area before writing NONE would leave the person with no
  // rows at all for a moment, and no rows means every area.
  //
  // The saved list is put in place before the write rather than after it, so a
  // tailor who ticks two boxes in quick succession is measured against the
  // answer to the first one and not the answer that was on screen when they
  // started. A refused write reloads the list rather than leaving a guess.
  function toggleArea(id, area, on) {
    var found = state.staff.rows.filter(function (r) { return r.id === id; })[0];
    if (!found) return Promise.resolve();

    var rows = state.staff.access[id] || [];
    if ((rows.indexOf(area) !== -1) === on) return Promise.resolve();

    // The marker is a stand-in for an empty list, not a member of it. Carrying it
    // forward would leave NONE sitting alongside a real area, so the next untick
    // of that area would read as "still has one" and the marker's own guarantee -
    // that an empty list is never stored - would quietly stop being true.
    var real = rows.filter(function (a) { return a !== NO_AREA; });
    var wanted = on ? real.concat([area]) : real.filter(function (a) { return a !== area; });
    var keep = wanted.length ? wanted : [NO_AREA];
    var toAdd = keep.filter(function (a) { return rows.indexOf(a) === -1; });
    var toDrop = rows.filter(function (a) { return keep.indexOf(a) === -1; });

    state.staff.access[id] = keep;
    paint();

    var adding = toAdd.length
      ? sb().from('staff_access').insert(toAdd.map(function (a) {
          return { user_id: id, area: a, level: 1 };
        })).select('area')
      : Promise.resolve({ error: null });

    return adding.then(function (res) {
      if (res.error) {
        toast(res.error.message, 'error');
        loadStaff();
        return;
      }
      if (!toDrop.length) return;

      return sb().from('staff_access')
        .delete()
        .eq('user_id', id)
        .in('area', toDrop)
        .select('area')
        .then(function (res2) {
          if (res2.error) {
            toast(res2.error.message, 'error');
            loadStaff();
          }
        });
    });
  }

  /* Form --------------------------------------------------------------- */

  function select(name, id, options, current) {
    return '<select class="ui-input" id="' + id + '" name="' + name + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o) + '"' + (o === current ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') +
    '</select>';
  }

  function formHtml() {
    var kind = state.form.kind;
    var row = state.form.row || {};
    var editing = !!state.form.row;

    var title = kind === 'dress'
      ? (editing ? 'Edit dress type' : 'New dress type')
      : (editing ? 'Edit price' : 'New price');

    var fields;

    if (kind === 'dress') {
      fields =
        '<div class="form-grid">' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setCategory">Category</label>' +
            select('category', 'setCategory', CATEGORIES, row.category || 'Gents') +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setDress">Dress type</label>' +
            '<input class="ui-input" id="setDress" value="' + esc(row.dress_type || '') + '" required maxlength="120" autocomplete="off">' +
          '</div>' +
        '</div>';
    } else {
      fields =
        '<div class="form-grid">' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setGroup">Group</label>' +
            select('group_name', 'setGroup', GROUPS, row.group_name || 'TAILORING') +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setItem">Item</label>' +
            '<input class="ui-input" id="setItem" value="' + esc(row.item || '') + '" required maxlength="120" autocomplete="off">' +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setOption">Option</label>' +
            '<input class="ui-input" id="setOption" value="' + esc(row.option === '-' ? '' : (row.option || '')) + '" maxlength="80" autocomplete="off">' +
            '<p class="ui-hint">Leave blank where there is no choice, such as a service.</p>' +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setPrice">Price</label>' +
            '<input class="ui-input" id="setPrice" inputmode="decimal" value="' +
              esc(row.price === undefined || row.price === null ? '' : row.price) + '" autocomplete="off">' +
            '<p class="ui-hint">Rupees. Blank means zero.</p>' +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="setExtra">Extra charge</label>' +
            '<input class="ui-input" id="setExtra" inputmode="decimal" value="' +
              esc(row.extra_charge === undefined || row.extra_charge === null ? '' : row.extra_charge) + '" autocomplete="off">' +
            '<p class="ui-hint">Added on top, for special work.</p>' +
          '</div>' +
        '</div>';
    }

    return '<div class="ui-card cust-form" id="setFormCard">' +
      '<h2 class="ui-card-title">' + esc(title) + '</h2>' +
      '<form id="setForm" novalidate>' + fields +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Save</button>' +
          '<button type="button" class="btn btn-secondary" id="setCancel">Cancel</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function save() {
    var kind = state.form.kind;
    var editing = !!state.form.row;

    var values;

    if (kind === 'dress') {
      var category = byId('setCategory').value;
      var dress = byId('setDress').value.trim();

      if (!dress) {
        toast('Enter a dress type name', 'error');
        byId('setDress').focus();
        return;
      }
      values = { category: category, dress_type: dress };
    } else {
      var item = byId('setItem').value.trim();
      var option = byId('setOption').value.trim();
      var price = parseAmount(byId('setPrice').value);
      var extra = parseAmount(byId('setExtra').value);

      if (!item) {
        toast('Enter an item name', 'error');
        byId('setItem').focus();
        return;
      }
      if (price === null || extra === null) {
        toast('Price must be a number, zero or more', 'error');
        byId('setPrice').focus();
        return;
      }
      values = {
        group_name: byId('setGroup').value,
        item: item,
        option: option === '' ? '-' : option,
        price: price,
        extra_charge: extra
      };
    }

    var table = kind === 'dress' ? 'dress_types' : 'prices';
    var label = kind === 'dress' ? 'Dress type' : 'Price';

    // Prices and dress types both carry a unique constraint on their business
    // key, so a duplicate is refused. See insertRow for how each key differs.
    var work;

    if (editing) {
      work = sb().from(table)
        .update(values)
        .eq('id', state.form.row.id)
        .select('id')
        .then(guardEmpty);
    } else {
      work = insertRow(kind, values);
    }

    work.then(function (res) {
      if (res.error) {
        toast(res.error.message, 'error');
        return;
      }
      state.form = null;
      toast(label + (editing ? ' updated' : ' added'), 'success');
      load();
    });
  }

  // An empty result on a write means RLS filtered the row out. It is not a
  // crash and it is not "nothing matched", so it is reported as a refusal.
  function guardEmpty(res) {
    if (res.error) return res;
    if (!res.data || res.data.length === 0) {
      return { error: { message: 'Only the Owner can change this.' } };
    }
    return res;
  }

  // The two tables are shaped differently, which is easy to get wrong.
  //
  //   dress_types  natural key (category, dress_type). No code, no status.
  //   prices       natural key (group_name, item, option), plus a P-nnn code
  //                and a status column.
  //
  // Asking dress_types for a code is not an empty result, it is a 400: the
  // column is not there to be read. That is why the code is generated for
  // prices only.
  function insertRow(kind, values) {
    if (kind === 'dress') {
      // .single() asks the database to hand the row back. Without it the
      // request carries Prefer: return=minimal and answers with no body, so a
      // write that RLS quietly discarded would look exactly like a success.
      return sb().from('dress_types')
        .insert(values)
        .single()
        .then(function (res) {
          if (res.error && res.error.status === 409) {
            return { error: { message: 'That dress type is already listed under this category.' } };
          }
          return res;
        });
    }
    return insertPrice(values, 0);
  }

  // Two people saving at the same moment can both read the same highest code,
  // so the first one to commit wins and the loser retries with the next. Three
  // attempts is far more than two tailors need at one counter.
  function insertPrice(values, attempt) {
    return nextPriceCode().then(function (code) {
      if (code === null) {
        return { error: { message: 'Could not work out a new price code. Try again.' } };
      }

      return sb().from('prices')
        .insert({ code: code, status: 'ACTIVE', ...values })
        .single()
        .then(function (res) {
          if (!res.error || res.error.status !== 409) return res;

          if (attempt < 2) return insertPrice(values, attempt + 1);
          return { error: { message: 'That item and option already exist.' } };
        });
    });
  }

  function nextPriceCode() {
    return sb().from('prices')
      .select('code')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        if (res.error) return null;
        var n = 1;
        if (res.data && res.data.length) {
          var m = /(\d+)\s*$/.exec(res.data[0].code || '');
          if (m) n = parseInt(m[1], 10) + 1;
        }
        return 'P-' + String(n).padStart(3, '0');
      });
  }

  function remove(kind, id) {
    var what = kind === 'dress' ? 'dress type' : 'price';
    if (!window.confirm('Delete this ' + what + '? This cannot be undone.')) return;

    var table = kind === 'dress' ? 'dress_types' : 'prices';

    sb().from(table)
      .delete()
      .eq('id', id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        // RLS reports a refused delete as an empty list, not an error, so an
        // empty result means the row was filtered out rather than removed.
        if (!res.data || res.data.length === 0) {
          return toast('Could not delete that ' + what + '. Only the Owner can, and it must already exist.', 'error');
        }
        toast(what.charAt(0).toUpperCase() + what.slice(1) + ' deleted', 'success');
        load();
      });
  }

  /* Events ------------------------------------------------------------- */

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-tab]'), function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-set-tab');
        state.search = '';
        state.form = null;
        paint();
        // Staff is not read with the rest, so it is fetched when it is opened.
        // The list is small and it is the one screen that must not be stale.
        if (state.tab === 'staff') loadStaff();
      });
    });

    var search = byId('setSearch');
    if (search) {
      search.addEventListener('input', function (e) {
        state.search = e.target.value;
        if (searchTimer) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
          paint();
          var again = byId('setSearch');
          if (again) {
            again.value = state.search;
            again.focus();
            try { again.setSelectionRange(state.search.length, state.search.length); } catch (err) {}
          }
        }, 260);
      });
    }

    var add = byId('setNew');
    if (add) {
      add.addEventListener('click', function () {
        state.form = { kind: state.tab === 'dress' ? 'dress' : 'price', row: null };
        paint();
        var field = byId(state.tab === 'dress' ? 'setDress' : 'setItem');
        if (field) field.focus();
      });
    }

    var cancel = byId('setCancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        state.form = null;
        paint();
      });
    }

    var form = byId('setForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        save();
      });
    }

    var shop = byId('shopForm');
    if (shop) {
      shop.addEventListener('submit', function (e) {
        e.preventDefault();
        saveShop();
      });
    }

    var wa = byId('waForm');
    if (wa) {
      wa.addEventListener('submit', function (e) {
        e.preventDefault();
        saveWhatsApp();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-set-edit]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-set-edit');
        var pool = state.tab === 'dress' ? state.dressRows : state.priceRows;
        var found = pool.filter(function (r) { return r.id === id; })[0];
        if (!found) return;
        state.form = { kind: state.tab === 'dress' ? 'dress' : 'price', row: found };
        paint();
        var field = byId(state.tab === 'dress' ? 'setDress' : 'setItem');
        if (field) field.focus();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-set-del]'), function (btn) {
      btn.addEventListener('click', function () {
        remove(state.tab === 'dress' ? 'dress' : 'price', btn.getAttribute('data-set-del'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-staff-role]'), function (sel) {
      sel.addEventListener('change', function () {
        setRole(sel.getAttribute('data-staff-role'), sel.value);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-staff-active]'), function (btn) {
      btn.addEventListener('click', function () {
        setActive(btn.getAttribute('data-staff-active'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-staff-area]'), function (box) {
      box.addEventListener('change', function () {
        toggleArea(box.getAttribute('data-staff-user'), box.getAttribute('data-staff-area'), box.checked);
      });
    });
  }

  return {
    mount: function () {
      return '<div id="settingsView"></div>';
    },

    render: function () {
      state.tab = 'dress';
      state.search = '';
      state.form = null;
      paint();
      load();
    },

    // Exposed so the harness can pin the tick boxes to the rule in auth.js
    // without reaching inside the module. Nothing in the app calls it.
    __effectiveAreas: effectiveAreas
  };
})();

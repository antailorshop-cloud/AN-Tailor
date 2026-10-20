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

  /* Clear data -----------------------------------------------------------
   *
   * The owner's one way to start the shop again on a clean slate. The records
   * it removes are the ones a shop builds up by using the app - customers,
   * measurements, orders, bills and payments, and resale stock - not master
   * data such as prices, dress types, the shop details or the staff list, which
   * are configuration and are edited in their own tabs.
   *
   * Each area names the tables it clears. A child table travels with its parent:
   * an order carries its items and its bill links, a bill carries its links.
   * Customers cannot be removed on their own - orders, bills, payments and
   * measurements name a customer with ON DELETE RESTRICT - so ticking Customers
   * pulls those in too, and the panel says so.
   */
  var CLEAR_AREAS = [
    { key: 'customers', label: 'Customers', tables: ['customers'] },
    { key: 'measurements', label: 'Measurements', tables: ['measurements'] },
    { key: 'orders', label: 'Orders', tables: ['orders', 'order_items', 'bill_orders'] },
    { key: 'bills', label: 'Bills', tables: ['bills', 'bill_orders'] },
    { key: 'payments', label: 'Payments', tables: ['payments'] },
    { key: 'resale', label: 'Resale stock', tables: ['resale_stock'] }
  ];

  // Children before parents, customers last: the orders, bills, payments and
  // measurements that name a customer block its removal. order_items is gone
  // before resale_stock because an item may point at a resale row.
  var CLEAR_ORDER = ['payments', 'bill_orders', 'order_items', 'bills', 'orders',
    'measurements', 'resale_stock', 'customers'];

  // The column each delete names. Every table has an id except bill_orders,
  // which is a link pair keyed by bill_id.
  var CLEAR_KEY = { bill_orders: 'bill_id' };

  // The record code each table's rows carry. Clearing a table restarts its
  // number from 0001, so a shop that starts again begins at AN-CUS-26-0001
  // rather than carrying on from a number whose record is gone. Clearing
  // customers drags in measurements, orders and bills, so those restart too.
  var CLEAR_CODE = { customers: 'CUS', measurements: 'MEA', orders: 'ORD', bills: 'BIL' };

  // Bill payment uses the first three. The last is the wording of the WhatsApp
  // bill message; an empty value means the standard wording, which is why it is
  // kept here beside the UPI id rather than hardcoded in the message builder.
  // The two print sizes are paper choices for two different documents, and they
  // are kept apart because a shop that prints receipts two-to-a-sheet almost
  // always still wants a full A4 bill.
  // shop_address, shop_phone and shop_email are the contact block printed under
  // the shop name on the bill. They are optional on purpose: a shop that has not
  // filled them in still gets a bill that prints, and a bill separated from its
  // garment bag still names the shop.
  var SHOP_KEYS = ['shop_name', 'shop_address', 'shop_phone', 'shop_email',
    'shop_instagram', 'upi_id', 'upi_payee_name', 'payment_terms',
    'due_reminder_days', 'wa_bill_message', 'wa_reminder_message',
    'wa_ready_message', 'wa_delivered_message', 'bill_print_size', 'wa_bill_size',
    'receipt_print_size'];

  var state = {
    tab: 'dress',
    search: '',
    dressRows: [],
    priceRows: [],
    shop: { shop_name: '', shop_address: '', shop_phone: '', shop_email: '',
      shop_instagram: '', upi_id: '', upi_payee_name: '', payment_terms: '',
      due_reminder_days: '', wa_bill_message: '', wa_reminder_message: '',
      wa_ready_message: '', wa_delivered_message: '', bill_print_size: '',
      wa_bill_size: '', receipt_print_size: '' },
    staff: { rows: [], access: {}, loading: false, error: null },
    clear: { picked: {}, busy: false },
    exporting: false,
    imp: { busy: false, plan: null, tables: null, report: null, error: null },
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
    var shop = { shop_name: '', shop_address: '', shop_phone: '', shop_email: '',
      shop_instagram: '', upi_id: '', upi_payee_name: '', payment_terms: '',
      due_reminder_days: '', wa_bill_message: '', wa_reminder_message: '',
      wa_ready_message: '', wa_delivered_message: '', bill_print_size: '',
      wa_bill_size: '', receipt_print_size: '' };
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
    return '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN');
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
      (isOwner()
        ? '<button class="set-tab' + (state.tab === 'backup' ? ' is-active' : '') + '" data-set-tab="backup">Backup</button>' +
          '<button class="set-tab' + (state.tab === 'imp' ? ' is-active' : '') + '" data-set-tab="imp">Import</button>' +
          '<button class="set-tab' + (state.tab === 'data' ? ' is-active' : '') + '" data-set-tab="data">Clear data</button>'
        : '') +
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
    if (state.tab === 'data') return clearPanel();
    if (state.tab === 'backup') return backupPanel();
    if (state.tab === 'imp') return importPanel();
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
      '<td>' + esc(r.option || '—') + '</td>' +
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

  /* One paper picker, used several times. The wording differs because the sheet
   * means something different for a bill than for a slip, and the size only ever
   * affects how the document is laid out - never a figure printed on it.
   *
   * `fallback` is what the picker shows when the shop has never chosen. Each sheet
   * has its own: the bill is printed on a full sheet and shared on a small one, so
   * an unset shop gets the bill on paper at A4 and the same bill on a phone at A5
   * without either of those being a decision somebody had to remember to make. */
  function printSizeField(id, label, current, kind, hint, fallback) {
    var def = fallback || (kind === 'receipt'
      ? window.ANT.printsize.RECEIPT_DEFAULT
      : window.ANT.printsize.DEFAULT);
    var picked = window.ANT.printsize.normalize(current, def);

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
          shopField('shopAddress', 'Address', s.shop_address, 'Printed under the shop name on the bill. Optional, but it is how a bill separated from its garment bag is traced back.') +
          shopField('shopPhone', 'Phone', s.shop_phone, 'Printed under the shop name on the bill. Optional.') +
          shopField('shopEmail', 'Gmail ID', s.shop_email, 'Your Gmail address. Printed under the shop name on the bill so a customer can reach the shop by mail. Optional.') +
          shopField('shopInstagram', 'Instagram', s.shop_instagram, 'Your username. Printed as a QR on the bill so a customer can follow the shop and reorder. Just the handle, or paste the profile link.') +
          shopField('shopUpi', 'UPI ID', upi, 'Like antailor@okhdfcbank. Printed as a QR on any bill with money still due.') +
          shopField('shopPayee', 'UPI payee name', s.upi_payee_name, 'The name the customer sees in their UPI app.') +
          shopField('shopTerms', 'Payment terms (e.g. "Due in 7 days")', s.payment_terms, 'Shown on bills and messages when there is a balance due.') +
          shopField('shopReminder', 'Due reminder days (comma-separated, e.g. "1,3,6")', s.due_reminder_days, 'Tells the dashboard which days to nudge after delivery date.') +
          shopField('shopConfirm', 'Confirm UPI ID', '', 'Type the new UPI ID again, but only when you change an existing one.') +
          printSizeField('shopPrintSize', 'Bill print size', s.bill_print_size, 'bill',
            'Lays out the printed bill only; it never changes a figure. The A4 sheet ' +
            'option prints one A5 bill on the left half and leaves the right half ' +
            'blank to cut off and reuse.') +
          printSizeField('shopWaBillSize', 'Bill PDF / WhatsApp size', s.wa_bill_size, 'bill',
            'The sheet the same bill is drawn on when it is saved as a PDF or sent ' +
            'on WhatsApp. Set apart from the print size because a bill read on a ' +
            'phone wants a narrower sheet than one read across a counter, and ' +
            'changing one never changes the other. It starts at A5. A bill ' +
            'already sent keeps the size it was sent at.',
            window.ANT.printsize.SHARE_DEFAULT) +
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

  // Instagram is typed three ways in practice: "@shop", "shop", or the whole
  // profile link pasted from the app. All three mean the same profile, so they are
  // reduced to the bare username and the link is rebuilt from it. A wrong handle
  // would print a QR that opens somebody else's page, so it is normalised here
  // rather than trusted.
  function normalizeInstagram(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    var fromUrl = /instagram\.com\/([^\/?#\s]+)/i.exec(s);
    if (fromUrl) s = fromUrl[1];
    // Instagram usernames are handled case-insensitively and stored lowercase, so
    // the value is lowercased here too: otherwise two rows that name the same
    // profile would print two different QRs.
    return s.replace(/^@+/, '').replace(/[\/?#].*$/, '').trim().toLowerCase();
  }

  // An email is typed with the words "Gmail ID" on the label but it does not have
  // to be a Gmail one, so no provider is assumed. What matters is that a typo
  // here prints an address nobody can reply to, so the value is reduced to a bare
  // address: a pasted "mailto:" link or a trailing slash is stripped, and the
  // domain is lowercased because domains are case-insensitive while the part
  // before the @ is not and is left exactly as typed.
  function normalizeEmail(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    s = s.replace(/^mailto:/i, '');
    s = s.split('?')[0].replace(/[\/?#].*$/, '');
    var at = s.lastIndexOf('@');
    if (at === -1) return s.toLowerCase();
    return s.slice(0, at) + '@' + s.slice(at + 1).toLowerCase();
  }

  // Returns a message when the address cannot be mailed, otherwise ''. The shape
  // is deliberately loose: it rejects the mistakes that actually happen (a space
  // pasted in, two @ signs, a missing domain) without trying to out-guess the
  // RFC, because a bill must not be blocked over an address that is merely
  // unusual.
  function emailProblem(email) {
    if (!email) return '';
    if (/\s/.test(email)) return 'The Gmail ID has a space in it. An email address cannot.';
    if ((email.match(/@/g) || []).length !== 1) return 'The Gmail ID needs exactly one "@".';
    var parts = email.split('@');
    if (!parts[0]) return 'The Gmail ID is missing the part before the "@".';
    if (!parts[1] || parts[1].indexOf('.') === -1 || /^\.|\.$/.test(parts[1])) {
      return 'That does not look like a Gmail ID. It should be something like antailor@gmail.com.';
    }
    return '';
  }

  function saveShop() {
    var name = byId('shopName').value.trim();
    // Newlines in the address would print as a broken line under the shop name,
    // so the field is flattened to a single line rather than trusted to be typed
    // that way.
    var address = byId('shopAddress').value.replace(/\s+/g, ' ').trim();
    var phone = byId('shopPhone').value.replace(/\s+/g, ' ').trim();
    var email = normalizeEmail(byId('shopEmail').value);
    var instagram = normalizeInstagram(byId('shopInstagram').value);
    var upiIn = window.ANT.upi.normalizeVpa(byId('shopUpi').value);
    var payee = byId('shopPayee').value.trim();
    var terms = byId('shopTerms').value.trim();
    var reminderDays = byId('shopReminder').value.trim();
    var confirm = window.ANT.upi.normalizeVpa(byId('shopConfirm').value);
    var printSize = window.ANT.printsize.normalize(byId('shopPrintSize').value);
    var waBillSize = window.ANT.printsize.normalize(byId('shopWaBillSize').value);
    var receiptSize = window.ANT.printsize.normalize(byId('shopReceiptSize').value);

    var problem = window.ANT.upi.vpaProblem(upiIn);
    if (problem) {
      toast(problem, 'error');
      byId('shopUpi').focus();
      return;
    }

    var badEmail = emailProblem(email);
    if (badEmail) {
      toast(badEmail, 'error');
      byId('shopEmail').focus();
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
      putSetting('shop_address', address),
      putSetting('shop_phone', phone),
      putSetting('shop_email', email),
      putSetting('shop_instagram', instagram),
      putSetting('upi_id', upiIn),
      putSetting('upi_payee_name', payee),
      putSetting('payment_terms', terms),
      putSetting('due_reminder_days', reminderDays),
      putSetting('bill_print_size', printSize),
      putSetting('wa_bill_size', waBillSize),
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
      '<p class="ui-hint" id="waCheck_' + id + '"></p>' +
      '<p class="ui-hint">' + esc(hint) + ' Clear the box and save to go back to the standard wording.</p>' +
    '</div>';
  }

  /* A word this build does not understand, written in brackets in a message
   * box. A typo is otherwise silent: the token is scrubbed, the customer gets
   * a shorter message, and nothing on screen shows what was lost - which is
   * how a pay link goes missing with the owner staring at a template that
   * looks right. Matching ignores case and spacing, the same as fill(), so
   * "{paylink}" is accepted rather than reported. */
  var WA_IDS = ['waBillMessage', 'waReminderMessage', 'waReadyMessage', 'waDeliveredMessage'];

  function waUnknown(text) {
    var wa = window.ANT.whatsapp || {};
    var known = {};
    ((wa.TOKENS || []).concat((wa.CANON || []).map(function (n) { return ['{' + n + '}']; })))
      .forEach(function (t) { known[String(t[0]).replace(/[{}]/g, '').toLowerCase()] = true; });

    var found = [];
    String(text == null ? '' : text).replace(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}/g, function (m, name) {
      if (!known[String(name).toLowerCase()] && found.indexOf(name) < 0) found.push(name);
      return m;
    });
    return found;
  }

  function checkWaTokens() {
    WA_IDS.forEach(function (id) {
      var box = byId(id);
      var note = byId('waCheck_' + id);
      if (!box || !note) return;
      var bad = waUnknown(box.value);
      note.textContent = bad.length
        ? 'Not understood and will be left out: ' + bad.map(function (n) { return '{' + n + '}'; }).join(', ')
        : '';
      note.style.color = bad.length ? 'var(--danger, #b00020)' : '';
    });
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
          'Sent from an order that is marked Finish.') +
        waBox('waDeliveredMessage', 'Order delivered', 'wa_delivered_message', 'DEFAULT_DELIVERED',
          'Sent from an order that is marked Delivery.') +
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
    var delivered = byId('waDeliveredMessage').value.trim();

    Promise.all([
      putSetting('wa_bill_message', bill),
      putSetting('wa_reminder_message', reminder),
      putSetting('wa_ready_message', ready),
      putSetting('wa_delivered_message', delivered)
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

  /* Backup ------------------------------------------------------------- */

  // A copy of everything, as CSV files in one zip. Only the Owner sees the tab,
  // and the read is the same one the app makes all day, so RLS decides what ends
  // up in it.
  function backupPanel() {
    if (!isOwner()) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Only the Owner can see this</div>' +
        '<p class="empty-text">Downloading the shop&#39;s records is the Owner&#39;s alone.</p>' +
      '</div></div>';
    }

    var list = 'Customers, measurements, orders and their items, bills and the orders ' +
      'they cover, payments and resale stock - with the setup behind them: prices, ' +
      'dress types, the shop details and the staff list.';

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Backup</h2>' +
      '<p class="ui-hint">Downloads a copy of the shop as a zip of CSV files, one file per ' +
        'table, which opens in Excel or Google Sheets. Worth taking before a clear-out, ' +
        'or at the end of each month.</p>' +
      '<p class="ui-hint">' + esc(list) + '</p>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-primary" id="backupRun"' +
          (state.exporting ? ' disabled' : '') + '>' +
          (state.exporting ? 'Preparing...' : 'Download backup (.zip)') +
        '</button>' +
      '</div>' +
    '</div>';
  }

  // Reads every table a page at a time, hands the files to the zip writer and
  // saves the result. Anything that fails stops the whole thing: a half backup
  // that looks complete is worse than none.
  function runExport() {
    if (!isOwner() || state.exporting) return;
    if (!window.ANT.export || !window.ANT.zip) {
      toast('Backup is not available.', 'error');
      return;
    }

    state.exporting = true;
    paint();

    window.ANT.export.run().then(function (res) {
      state.exporting = false;
      var total = res.counts.reduce(function (a, n) { return a + n; }, 0);
      toast('Backup ready: ' + total + ' rows across ' + res.counts.length + ' tables.', 'success');
    }).catch(function (e) {
      state.exporting = false;
      toast('Could not make the backup: ' + (e && e.message ? e.message : e), 'error');
    }).then(function () {
      paint();
    });
  }

  /* Import ------------------------------------------------------------- */

  function importPanel() {
    if (!isOwner()) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Only the Owner can see this</div>' +
        '<p class="empty-text">Bringing records in is the Owner&#39;s alone.</p>' +
      '</div></div>';
    }

    if (state.imp.report) return importReport();
    if (state.imp.plan) return importPlan();

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Import</h2>' +
      '<p class="ui-hint">Bring in old records two ways: upload a Backup zip, or fill in the ' +
        'Excel template below and upload that. Rows are added to what is already here; a ' +
        'record that is already in the shop is left exactly as it is, and only the new rows ' +
        'are added.</p>' +
      '<p class="ui-hint">The Excel template carries Customers, Orders (with their items) and ' +
        'Payments, linked by the codes you type. A Backup zip carries every table.</p>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="impFile">File</label>' +
        '<input class="ui-input" id="impFile" type="file" accept=".zip,.csv,.xlsx" multiple>' +
      '</div>' +
      (state.imp.error
        ? '<p class="ui-hint" style="color:var(--danger)">' + esc(state.imp.error) + '</p>'
        : '') +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-primary" id="impReview"' +
          (state.imp.busy ? ' disabled' : '') + '>' +
          (state.imp.busy ? 'Reading...' : 'Review file') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" id="impTemplate">Download template</button>' +
      '</div>' +
    '</div>';
  }

  function importPlan() {
    var plan = state.imp.plan;
    var t = plan.totals;
    var rows = plan.tables.filter(function (r) { return r.found; }).map(function (r) {
      return '<tr><td>' + esc(r.table) + '</td><td>' + r.found + '</td>' +
        '<td>' + r.add + '</td><td>' + r.skip + '</td></tr>';
    }).join('');

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Import</h2>' +
      '<p class="ui-hint">Found ' + t.found + ' rows. ' + t.add + ' are new and will be added; ' +
        t.skip + ' already exist and will be left alone.</p>' +
      (rows
        ? '<div class="table-wrap"><table class="ui-table"><thead><tr>' +
            '<th>Table</th><th>In file</th><th>New</th><th>Skip</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="ui-hint">Nothing in that file could be read.</p>') +
      (state.imp.error
        ? '<p class="ui-hint" style="color:var(--danger)">' + esc(state.imp.error) + '</p>'
        : '') +
      '<div class="form-actions">' +
        (t.add
          ? '<button type="button" class="btn btn-primary" id="impRun"' +
              (state.imp.busy ? ' disabled' : '') + '>' +
              (state.imp.busy ? 'Importing...' : 'Import ' + t.add + ' rows') +
            '</button>'
          : '') +
        '<button type="button" class="btn btn-secondary" id="impReset">Choose another file</button>' +
      '</div>' +
    '</div>';
  }

  function importReport() {
    var r = state.imp.report;
    var t = r.totals;
    var rows = r.tables.filter(function (x) { return x.inserted || x.skip; }).map(function (x) {
      return '<tr><td>' + esc(x.table) + '</td><td>' + x.inserted + '</td>' +
        '<td>' + x.skip + '</td></tr>';
    }).join('');
    var fail = r.failures.length
      ? '<p class="ui-hint" style="color:var(--danger)">' + r.failures.length +
          ' row(s) could not be added: ' + esc(r.failures.slice(0, 5).map(function (f) {
            return f.table + ' ' + f.code; }).join(', ')) +
          (r.failures.length > 5 ? ' ...' : '') + '</p>'
      : '';

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Import done</h2>' +
      '<p class="ui-hint">Added ' + t.inserted + ' rows; ' + t.skip +
        ' were already here and were left alone.</p>' +
      (rows
        ? '<div class="table-wrap"><table class="ui-table"><thead><tr>' +
            '<th>Table</th><th>Added</th><th>Skipped</th></tr></thead><tbody>' + rows +
          '</tbody></table></div>'
        : '') +
      fail +
      '<p class="ui-hint">Reload the app to see the new records on every screen.</p>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-primary" id="impReload">Reload</button>' +
        '<button type="button" class="btn btn-secondary" id="impDone">Close</button>' +
      '</div>' +
    '</div>';
  }

  function impResetState() {
    state.imp = { busy: false, plan: null, tables: null, report: null, error: null };
  }

  function reviewImport() {
    var input = byId('impFile');
    var files = input && input.files;
    if (!files || !files.length) {
      state.imp.error = 'Choose a backup file first.';
      paint();
      return;
    }

    state.imp.busy = true;
    state.imp.error = null;
    state.imp.plan = null;
    state.imp.report = null;
    paint();

    var hasXlsx = Array.prototype.some.call(files, function (f) {
      return /\.xlsx$/i.test(f.name || '');
    });
    var reading = (hasXlsx && window.ANT.excel)
      ? window.ANT.excel.read(files)
      : window.ANT.restore.readBackup(files);

    reading.then(function (found) {
      if (!found.names.length) {
        throw new Error(hasXlsx
          ? 'No sheets were found in that Excel file.'
          : 'No CSV files were found in that file.');
      }
      state.imp.tables = found.tables;
      return window.ANT.restore.preview(found.tables);
    }).then(function (plan) {
      state.imp.busy = false;
      state.imp.plan = plan;
      paint();
    }).catch(function (e) {
      state.imp.busy = false;
      state.imp.error = (e && e.message) ? e.message : String(e);
      paint();
    });
  }

  function runImport() {
    if (!state.imp.plan || state.imp.busy) return;
    var add = state.imp.plan.totals.add;
    if (!window.confirm('Add ' + add + ' rows to the shop?\n\nNothing that is already ' +
      'here will change.')) return;

    state.imp.busy = true;
    state.imp.error = null;
    paint();

    window.ANT.restore.run(state.imp.tables).then(function (report) {
      state.imp.busy = false;
      state.imp.report = report;
      toast('Imported ' + report.totals.inserted + ' rows.', 'success');
      paint();
      load();
    }).catch(function (e) {
      state.imp.busy = false;
      state.imp.error = (e && e.message) ? e.message : String(e);
      paint();
    });
  }

  function downloadTemplate() {
    if (!window.ANT.excel) return;
    try {
      var blob = window.ANT.excel.template();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'AN-Tailor-Import-Template.xlsx';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        try { URL.revokeObjectURL(url); } catch (e) {}
      }, 100);
      toast('Template downloaded. Open it in Excel, fill it in, then upload it here.', 'success');
    } catch (e) {
      toast('Could not build the template.', 'error');
    }
  }

  /* Clear data --------------------------------------------------------- */

  // The tables a selection actually removes, in the order they must go. Ticking
  // a parent drags in the children and the rows that point at it, so a ticked
  // area never fails on a foreign key halfway through.
  function clearTables() {
    var want = {};
    CLEAR_AREAS.forEach(function (a) {
      if (state.clear.picked[a.key]) {
        a.tables.forEach(function (t) { want[t] = true; });
      }
    });
    if (want.customers) {
      want.measurements = want.orders = want.bills = want.payments = true;
    }
    if (want.orders) want.bill_orders = true;
    if (want.bills) want.bill_orders = true;
    return CLEAR_ORDER.filter(function (t) { return want[t]; });
  }

  function clearPanel() {
    if (!isOwner()) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">Only the Owner can see this</div>' +
        '<p class="empty-text">Clearing the shop&#39;s records is the Owner&#39;s alone.</p>' +
      '</div></div>';
    }

    var picked = state.clear.picked;
    var boxes = CLEAR_AREAS.map(function (a) {
      var on = !!picked[a.key];
      return '<label class="clear-area' + (on ? ' is-on' : '') + '">' +
        '<input type="checkbox" data-clear-area="' + esc(a.key) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + esc(a.label) + '</span>' +
      '</label>';
    }).join('');

    var all = CLEAR_AREAS.every(function (a) { return picked[a.key]; });

    return '<div class="ui-card cust-form">' +
      '<h2 class="ui-card-title">Clear data</h2>' +
      '<p class="ui-hint">Permanently removes the shop&#39;s records. There is no undo and no ' +
        'bin to restore from, so this is the Owner&#39;s alone. Record numbers restart at ' +
        '0001, so a shop started again begins at AN-CUS-26-0001. What it does not touch: ' +
        'prices, dress types, the shop details and the staff list, which are set up again ' +
        'in their own tabs.</p>' +
      '<div class="ui-field">' +
        '<span class="ui-label">What to clear</span>' +
        '<div class="clear-areas">' + boxes + '</div>' +
        '<p class="ui-hint">Ticking Customers also clears their measurements, orders, bills ' +
          'and payments, because a customer with history cannot be removed on its own.</p>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="clearPhrase">Type CLEAR to confirm</label>' +
          '<input class="ui-input" id="clearPhrase" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="clearPassword">Your password</label>' +
          '<input class="ui-input" id="clearPassword" type="password" autocomplete="current-password">' +
          '<p class="ui-hint">Asked again because a phone can be left signed in.</p>' +
        '</div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-danger" id="clearRun"' +
          (state.clear.busy ? ' disabled' : '') + '>' +
          (state.clear.busy ? 'Clearing...' : 'Clear selected data') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" id="clearAll">' +
          (all ? 'Untick all' : 'Tick all') +
        '</button>' +
      '</div>' +
    '</div>';
  }

  // Deletes the chosen tables one after another, children first. A stop is a
  // real error rather than an empty result: RLS answers a refused multi-row
  // delete with no rows and no error, but a genuine failure (a foreign key that
  // was not accounted for, a lost connection) raises and is reported. Every
  // table deletes with a filter - `id is not null` matches every row - because
  // PostgREST will not run an unfiltered delete.
  function wipe(tables) {
    var counts = {};
    return tables.reduce(function (chain, t) {
      return chain.then(function () {
        var key = CLEAR_KEY[t] || 'id';
        return sb().from(t)
          .delete()
          .not(key, 'is', null)
          .select('*')
          .then(function (res) {
            if (res.error) throw new Error(res.error.message || ('Could not clear ' + t));
            counts[t] = (res.data || []).length;
          });
      });
    }, Promise.resolve()).then(function () { return counts; });
  }

  // Restart the record numbers for the types whose records just went, so the
  // shop begins again at 0001 instead of carrying on from a number whose record
  // is gone. The counters sit behind a security-definer function, because the
  // API has no direct path to code_counters at all. A database without the
  // reset-codes migration simply has no such function, and that is reported
  // rather than thrown - the records are already gone and a working clear must
  // not look like a failure.
  function resetCodes(tables) {
    var prefixes = [];
    tables.forEach(function (t) {
      var p = CLEAR_CODE[t];
      if (p && prefixes.indexOf(p) === -1) prefixes.push(p);
    });
    if (!prefixes.length) return Promise.resolve({ ok: true });

    return sb().rpc('reset_record_codes', { p_prefixes: prefixes }).then(function (res) {
      if (res.error) return { ok: false, missing: true };
      return { ok: true };
    });
  }

  // Clearing the bill rows does not clear the bill PDFs: those are objects in
  // storage, and the Bills page meters the bucket rather than the table. So a
  // shop cleared of bills would still read "32 bills stored" with nothing on the
  // page to open. The files go with the rows, and only when the bills went - a
  // clear that leaves bills alone must leave their files alone too. A build
  // without the bills module (this panel's own tests) simply skips it.
  function clearPdfs(tables) {
    if (tables.indexOf('bills') === -1) return Promise.resolve({ removed: 0 });
    var bills = window.ANT.bills;
    if (!bills || typeof bills.clearStoredPdfs !== 'function') return Promise.resolve({ removed: 0 });
    return bills.clearStoredPdfs();
  }

  function clearSelected() {
    if (!isOwner()) return;

    var tables = clearTables();
    if (!tables.length) {
      toast('Tick what to clear first.', 'error');
      return;
    }

    var phrase = String((byId('clearPhrase') || {}).value || '').trim();
    if (phrase.toUpperCase() !== 'CLEAR') {
      toast('Type CLEAR in the box to confirm.', 'error');
      return;
    }

    var password = String((byId('clearPassword') || {}).value || '');
    if (!password) {
      toast('Enter your password to confirm.', 'error');
      return;
    }

    var names = tables.map(function (t) { return t.replace('_', ' '); }).join(', ');
    if (!window.confirm('Permanently delete: ' + names + '?\n\nThis cannot be undone.')) return;

    state.clear.busy = true;
    paint();

    window.ANT.auth.verifyPassword(password).then(function (auth) {
      if (!auth || !auth.ok) {
        state.clear.busy = false;
        paint();
        toast((auth && auth.error) || 'Could not confirm it is you.', 'error');
        return;
      }
      return wipe(tables).then(function (counts) {
        return resetCodes(tables).then(function (codes) {
          return clearPdfs(tables).then(function (pdfs) {
            state.clear.busy = false;
            state.clear.picked = {};
            var cleared = 'Cleared ' + tables.map(function (t) {
              return counts[t] + ' ' + t.replace('_', ' ');
            }).join(', ');
            if (pdfs && pdfs.removed) {
              cleared += ' and ' + pdfs.removed + ' stored PDF' + (pdfs.removed === 1 ? '' : 's');
            }
            if (codes.ok) {
              toast(cleared, 'success');
            } else {
              toast(cleared + '. Record numbers were not restarted - run the ' +
                'reset-codes migration to begin at 0001 again.', 'error');
            }
            if (pdfs && pdfs.error) {
              toast('Some stored bill PDFs could not be removed: ' + pdfs.error, 'error');
            }
            paint();
            load();
          });
        });
      });
    }).catch(function (e) {
      state.clear.busy = false;
      paint();
      toast('Could not clear the data: ' + (e && e.message ? e.message : e), 'error');
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
      WA_IDS.forEach(function (id) {
        var box = byId(id);
        if (box) box.addEventListener('input', checkWaTokens);
      });
      checkWaTokens();
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

    Array.prototype.forEach.call(document.querySelectorAll('[data-clear-area]'), function (box) {
      box.addEventListener('change', function () {
        var key = box.getAttribute('data-clear-area');
        if (box.checked) state.clear.picked[key] = true;
        else delete state.clear.picked[key];
        paint();
      });
    });

    var clearAll = byId('clearAll');
    if (clearAll) {
      clearAll.addEventListener('click', function () {
        var all = CLEAR_AREAS.every(function (a) { return state.clear.picked[a.key]; });
        state.clear.picked = {};
        if (!all) CLEAR_AREAS.forEach(function (a) { state.clear.picked[a.key] = true; });
        paint();
      });
    }

    var clearRun = byId('clearRun');
    if (clearRun) {
      clearRun.addEventListener('click', clearSelected);
    }

    var backupRun = byId('backupRun');
    if (backupRun) {
      backupRun.addEventListener('click', runExport);
    }

    var impReview = byId('impReview');
    if (impReview) impReview.addEventListener('click', reviewImport);
    var impTemplate = byId('impTemplate');
    if (impTemplate) impTemplate.addEventListener('click', downloadTemplate);
    var impRun = byId('impRun');
    if (impRun) impRun.addEventListener('click', runImport);
    var impReset = byId('impReset');
    if (impReset) impReset.addEventListener('click', function () { impResetState(); paint(); });
    var impDone = byId('impDone');
    if (impDone) impDone.addEventListener('click', function () { impResetState(); paint(); });
    var impReload = byId('impReload');
    if (impReload) impReload.addEventListener('click', function () { window.location.reload(); });
  }

  return {
    mount: function () {
      return '<div id="settingsView"></div>';
    },

    render: function () {
      state.tab = 'dress';
      state.search = '';
      state.form = null;
      state.clear = { picked: {}, busy: false };
      state.exporting = false;
      impResetState();
      paint();
      load();
    },

    // Exposed so the harness can pin the tick boxes to the rule in auth.js
    // without reaching inside the module. Nothing in the app calls it.
    __effectiveAreas: effectiveAreas
  };
})();

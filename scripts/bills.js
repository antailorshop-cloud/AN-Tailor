/* AN TAILOR - Bills.
 *
 * A bill is one document that can cover several orders of the same customer,
 * which is how the shop hands work over and how the customer is shown what is
 * owed. The legacy system already worked this way and the arithmetic is kept
 * exactly as it was:
 *
 *   total       = sum of order.total
 *   discount    = sum of order.discount
 *   advance     = sum of order.advance
 *   bill_amount = total - discount
 *   balance     = bill_amount - advance
 *
 * The discount is subtracted here exactly as the legacy sheet did, even though
 * the order screen presents the same discount as a deduction. Recomputing it a
 * different way would quietly disagree with the orders behind the bill, and a
 * bill that does not add up to its own orders is worse than a repeated formula.
 *
 * A bill never changes an order. The order balance stays the authority on what
 * is owed, and a bill is a statement about several orders at one moment. That
 * is why money is still taken on the Payments page, one order at a time, and
 * why a bill is not a shortcut around that.
 *
 * Which orders are already billed is worked out from bill_orders rather than a
 * flag on the order, so taking an order off a bill frees it again with no repair
 * step.
 *
 * The method and date on a bill are not typed in. They are read from the
 * payments already taken against the selected orders: the distinct methods, and
 * the date of the most recent one. That is what the legacy sheet recorded, and
 * it means a bill cannot claim a payment that was never made.
 *
 * Editing is limited to the Owner. bills may be updated by any member under the
 * RLS, but a bill_orders row may only be deleted by the Owner, so a staff edit
 * that removes an order would fail at the database. Rather than show an edit
 * that cannot finish, the button is only drawn for the Owner. Staff can still
 * create and print bills.
 *
 * PDF storage was a Google Drive feature in the legacy system. bills.pdf_path
 * is left for when a file store is decided on, and the print view is built in
 * the browser instead, so a bill prints with no server round trip and no Drive
 * account. WhatsApp is a text message built by scripts/whatsapp.js and sent
 * through wa.me, so it needs no file store either.
 */

window.ANT = window.ANT || {};

window.ANT.bills = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };
  var money = function (v) { return window.ANT.money(v); };

  var PAGE_SIZE = 25;

  // How many customers a name search will offer to pick from. A list long enough
  // to scroll past its own end is a list nobody reads, and the number of matches
  // is shown so the tailor knows to narrow it down.
  var MATCH_LIMIT = 8;

  var state = {
    customer: null,
    orders: [],
    bills: [],
    selected: {},
    notes: '',
    editing: null,
    page: 0,
    count: 0,
    loading: false,
    busy: false,
    error: null,
    // What the tailor typed, and who it matched. A search that lands on more
    // than one customer is a list to choose from, never a guess at which one
    // was meant, because the wrong customer's bill cannot be taken back.
    term: '',
    matches: [],
    matchTotal: 0,
    // Shop details for the printed bill and the WhatsApp message. Read once
    // from shop_settings; a missing or unreadable row simply means no UPI code
    // is drawn and the WhatsApp message falls back to the standard wording.
    shop: { name: '', upiId: '', payee: '', waBillMessage: '', waReminderMessage: '', printSize: '' }
  };

  function byId(id) { return document.getElementById(id); }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function dateLabel(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function isOwner() {
    var u = window.ANT.auth && window.ANT.auth.current && window.ANT.auth.current();
    return !!u && u.role === 'owner';
  }

  function reason(res) {
    return (res && res.error && res.error.message) || 'the request was rejected.';
  }

  // Ten digits and nothing else, used only to recognise a mobile number. A
  // partial number matches the wrong customer, and a bill shown to the wrong
  // person cannot be taken back.
  function isMobileTerm(term) {
    return /^\d{10}$/.test(term);
  }

  // What the tailor typed: a mobile number, part of a name, or a customer code.
  function cleanTerm(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  // PostgREST reads , ( ) and % inside a filter as structure, and a stray one
  // from a pasted value turns into a query error rather than a search. The
  // characters are dropped, which only ever widens the search.
  function likeTerm(term) {
    return '*' + term.replace(/[*%,()]/g, ' ') + '*';
  }

  /* Totals ---------------------------------------------------------------- */

  // The one place the bill arithmetic lives, so the summary, the insert and the
  // rollback all quote the same figure.
  function computeTotals(list) {
    var total = 0;
    var discount = 0;
    var advance = 0;

    (list || []).forEach(function (o) {
      total += num(o.total);
      discount += num(o.discount);
      advance += num(o.advance);
    });

    var billAmount = round2(total - discount);
    return {
      count: (list || []).length,
      total: round2(total),
      discount: round2(discount),
      advance: round2(advance),
      billAmount: billAmount,
      balance: round2(billAmount - advance)
    };
  }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (id) {
      return state.selected[id];
    });
  }

  function selectedOrders() {
    return state.orders.filter(function (o) {
      return state.selected[o.id];
    });
  }

  function selectedTotals() {
    return computeTotals(selectedOrders());
  }

  /* Loading --------------------------------------------------------------- */

  function searchCustomer(term) {
    var clean = cleanTerm(term);

    state.matches = [];
    state.matchTotal = 0;
    state.term = clean;

    if (!clean) {
      resetFor();
      state.matches = [];
      paint();
      return Promise.resolve();
    }

    resetFor();
    paint();

    var q = sb().from('customers')
      .select('id,code,name,mobile,address', { count: true })
      .is('archived_at', null)
      .order('name', true);

    // A full ten digit number is a lookup, not a search: exactly one customer can
    // hold it, and matching on the column keeps the result to that one row
    // instead of trusting an ilike to exclude a longer number elsewhere.
    if (isMobileTerm(clean)) q = q.eq('mobile', clean);
    else {
      var wild = likeTerm(clean);
      q = q.or('name.ilike.' + wild + ',mobile.ilike.' + wild + ',code.ilike.' + wild);
    }

    // A name is rarely unique, so a name that lands on one customer opens their
    // bills, while anything wider is offered as a list to pick from. Reading that
    // list is not a guess: the owner clicks the row they meant.
    return q.limit(MATCH_LIMIT).then(function (res) {
      if (res.error) {
        state.loading = false;
        state.error = 'The customer could not be searched: ' + reason(res);
        paint();
        return;
      }

      var hits = res.data || [];
      state.matchTotal = res.count == null ? hits.length : res.count;

      if (state.matchTotal === 1) {
        return openCustomer(hits[0]);
      }

      state.matches = hits;
      state.loading = false;

      if (!hits.length) {
        state.error = 'No customer matches "' + clean + '".';
      } else if (state.matchTotal > hits.length) {
        state.error = hits.length + ' of ' + state.matchTotal +
          ' customers match "' + clean + '". Showing the first ' + hits.length + '.';
      }

      paint();
    });
  }

  function openCustomer(customer) {
    state.customer = customer;
    state.matches = [];
    state.matchTotal = 0;
    // The box keeps the customer's own number rather than the name that was
    // typed, so it reads back as an exact reference to who is on screen.
    state.term = customer.mobile || '';
    return loadOrders().then(loadBills);
  }

  function resetFor() {
    state.customer = null;
    state.orders = [];
    state.bills = [];
    state.selected = {};
    state.editing = null;
    state.notes = '';
    state.page = 0;
    state.count = 0;
    state.loading = true;
    state.busy = false;
    state.error = null;
    // Left as typed, because a repaint mid-search would otherwise empty the box
    // under the tailor's caret.
  }

  /* Shop settings --------------------------------------------------------- */

  // The shop's details live in shop_settings, one row per key. They are read here
  // rather than copied onto the bill, so changing the shop in Settings changes the
  // next bill printed with no re-save of anything. A missing row is simply blank
  // and the bill prints without that part of the letterhead.
  function loadShop() {
    return sb().from('shop_settings')
      .select('key,value')
      .then(function (res) {
        var shop = { name: '', address: '', phone: '', email: '', instagram: '',
          upiId: '', payee: '', waBillMessage: '', waReminderMessage: '',
          printSize: '' };

        if (!res.error && res.data) {
          res.data.forEach(function (row) {
            if (row.key === 'shop_name') shop.name = row.value || '';
            else if (row.key === 'shop_address') shop.address = row.value || '';
            else if (row.key === 'shop_phone') shop.phone = row.value || '';
            else if (row.key === 'shop_email') shop.email = row.value || '';
            else if (row.key === 'shop_instagram') shop.instagram = row.value || '';
            else if (row.key === 'upi_id') shop.upiId = row.value || '';
            else if (row.key === 'upi_payee_name') shop.payee = row.value || '';
            else if (row.key === 'wa_bill_message') shop.waBillMessage = row.value || '';
            else if (row.key === 'wa_reminder_message') shop.waReminderMessage = row.value || '';
            else if (row.key === 'bill_print_size') shop.printSize = row.value || '';
          });
        }

        state.shop = shop;
      });
  }

  // Cancelled orders are left out. The legacy billing sheet listed every order
  // of the customer including cancelled ones, but a cancelled order is work that
  // was called off, and putting it on a bill would ask the customer to pay for
  // it. A cancelled order is cancelled, not billed, and needs nothing here.
  function loadOrders() {
    return sb().from('orders')
      .select('id,code,order_date,delivery_date,status,total,discount,advance,balance')
      .eq('customer_id', state.customer.id)
      .neq('status', 'Cancelled')
      .is('archived_at', null)
      .order('order_date', false)
      .then(function (res) {
        if (res.error) {
          state.error = 'The orders could not be loaded: ' + reason(res);
          state.orders = [];
          state.loading = false;
          paint();
          return;
        }

        state.orders = res.data || [];
        return markBilled().then(paint);
      });
  }

  function markBilled() {
    var ids = state.orders.map(function (o) { return o.id; });
    if (!ids.length) return Promise.resolve();

    return sb().from('bill_orders')
      .select('order_id')
      .in('order_id', ids)
      .then(function (res) {
        var taken = {};
        if (!res.error && res.data) {
          res.data.forEach(function (r) { taken[r.order_id] = true; });
        }
        // A read that fails leaves every order looking free, so the checkbox
        // rules below are the backstop rather than this flag.
        state.orders.forEach(function (o) { o.billed = !!taken[o.id]; });
      });
  }

  // count is asked for explicitly, otherwise the pager has no total to divide by
  // and silently shows one page.
  function loadBills() {
    var from = state.page * PAGE_SIZE;

    return sb().from('bills')
      .select('id,code,total,discount,advance,bill_amount,balance,bill_date,notes,method,paid_on,created_at', { count: true })
      .eq('customer_id', state.customer.id)
      .is('archived_at', null)
      .order('bill_date', false)
      .order('created_at', false)
      .range(from, from + PAGE_SIZE - 1)
      .then(function (res) {
        if (res.error) {
          toast('Bill history could not be loaded: ' + reason(res), 'error');
          state.bills = [];
          state.count = 0;
          state.loading = false;
          paint();
          return;
        }

        state.bills = res.data || [];
        state.count = res.count == null ? state.bills.length : res.count;
        state.loading = false;
        paint();
      });
  }

  // bills.code is NOT NULL UNIQUE with no default, so the number has to exist
  // before the insert. BILL-<year>-<0001> is the legacy shape, except the
  // counter runs across every bill rather than restarting each year, the way
  // generateBillId_ read the highest number on the whole sheet. The sequence is
  // only ever added to, so a bill can never be handed a number already in use.
  function nextCode() {
    return sb().from('bills')
      .select('code')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        var n = 1;
        if (res && !res.error && res.data && res.data.length) {
          var m = /(\d+)\s*$/.exec(res.data[0].code || '');
          if (m) n = parseInt(m[1], 10) + 1;
        }
        return 'BILL-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0');
      });
  }

  function isDuplicate(res) {
    var m = String((res && res.error && res.error.message) || '').toLowerCase();
    return m.indexOf('duplicate') > -1 || m.indexOf('unique') > -1;
  }

  // The method and date on the bill are the ones already on the payments for
  // these orders, never something typed here. A bill that claimed a payment
  // mode nobody recorded would be a false statement to the customer.
  function paymentFromOrders(orderIds) {
    if (!orderIds.length) return Promise.resolve({ method: '', paidOn: null });

    return sb().from('payments')
      .select('order_id,method,paid_on,created_at')
      .in('order_id', orderIds)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          return { method: '', paidOn: null };
        }

        var modes = [];
        var latest = null;
        var latestKey = '';

        res.data.forEach(function (p) {
          var mode = String(p.method || '').trim();
          if (mode && modes.indexOf(mode) === -1) modes.push(mode);

          // created_at settles a tie on the same date, so two payments recorded
          // on one day still end on the one that came second.
          var when = String(p.paid_on || '') + 'T' + String(p.created_at || '');
          if (!latest || when > latestKey) {
            latestKey = when;
            latest = p.paid_on || null;
          }
        });

        return { method: modes.join(', '), paidOn: latest };
      });
  }

  /* View ----------------------------------------------------------------- */

  function mount() {
    return '<div id="billsView"></div>';
  }

  function paint() {
    var host = byId('billsView');
    if (!host) return;

    // Ticking an order repaints the whole view, which would otherwise throw away
    // the caret in the notes box mid-sentence.
    var noteHadFocus = !!byId('billNotes') && document.activeElement === byId('billNotes');

    host.innerHTML = head() + searchCard() +
      (state.customer ? customerSection() : matchPanel());
    wire();

    if (noteHadFocus) {
      var box = byId('billNotes');
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  function head() {
    return '<div class="page-head"><div>' +
      '<h1 class="page-head-title">Bills</h1>' +
      '<p class="page-head-sub">One bill can cover several orders of the same ' +
      'customer. Searching by mobile number finds the customer and their orders.</p>' +
      '</div></div>';
  }

  function searchCard() {
    return '<div class="ui-card"><div class="ui-field">' +
      '<label class="ui-label" for="billMobile">Customer</label>' +
      '<input class="ui-input" id="billMobile" type="search" autocomplete="off" ' +
      'value="' + esc(state.term) + '" ' +
      'placeholder="Mobile number, name or customer code">' +
      '<p class="ui-hint">Search by mobile number, name or customer code. ' +
        'A full 10-digit number opens that customer straight away; a name that ' +
        'matches more than one person gives you a list to pick from.</p>' +
      '</div>' +
      (state.error
        ? '<div class="ord-err"><p class="ui-card-sub">' + esc(state.error) + '</p></div>'
        : '') +
      '</div>';
  }

  // Shown when a search did not settle on one customer. Picking a row is a
  // deliberate act, so a bill is never built for someone the tailor did not mean.
  function matchPanel() {
    if (state.loading || !state.matches.length) return '';

    return '<div class="ui-card"><h2 class="ui-card-title">Matching customers</h2>' +
      '<p class="ui-card-sub">Pick the customer to bill.</p>' +
      '<table class="ui-table"><thead><tr>' +
      '<th>Name</th><th>Code</th><th>Mobile</th><th></th>' +
      '</tr></thead><tbody>' + state.matches.map(function (m) {
        return '<tr>' +
          '<td><span class="ord-sub-strong">' + esc(m.name) + '</span>' +
            (m.address ? '<br><span class="ord-sub">' + esc(m.address) + '</span>' : '') +
          '</td>' +
          '<td>' + esc(m.code) + '</td>' +
          '<td>' + esc(m.mobile) + '</td>' +
          '<td class="ord-row-actions">' +
            '<button class="btn btn-sm btn-primary" data-bill-pick="' +
              esc(m.id) + '">Open</button>' +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function customerSection() {
    return customerCard() + ordersCard() + summaryCard() + actionCard() + historyCard() + pager();
  }

  function customerCard() {
    var c = state.customer;
    return '<div class="ui-card"><h2 class="ui-card-title">' + esc(c.name) + '</h2>' +
      '<p class="ui-card-sub">' + esc(c.code) + ' &middot; ' + esc(c.mobile) +
      (c.address ? ' &middot; ' + esc(c.address) : '') + '</p></div>';
  }

  function ordersCard() {
    var body;
    if (state.loading) {
      body = '<div class="empty"><p class="empty-text">Loading&hellip;</p></div>';
    } else if (!state.orders.length) {
      body = '<div class="empty"><div class="empty-title">No orders</div>' +
        '<p class="empty-text">This customer has no orders to put on a bill.</p></div>';
    } else {
      body = '<table class="ui-table"><thead><tr>' +
        '<th class="bill-pick"></th><th>Order</th><th>Order date</th><th>Delivery</th>' +
        '<th>Status</th><th class="num">Total</th><th class="num">Discount</th>' +
        '<th class="num">Paid</th><th class="num">Balance</th>' +
        '</tr></thead><tbody>' + state.orders.map(orderRow).join('') + '</tbody></table>';
    }

    return '<div class="ui-card"><h2 class="ui-card-title">Orders</h2>' +
      '<p class="ui-card-sub">' +
      (state.editing
        ? 'Editing ' + esc(state.editing.code) + '. Add or remove orders, then save.'
        : 'Tick the orders to go on one bill. An order already on a bill cannot be added again.') +
      '</p>' + body +
      (state.editing
        ? '<div class="ui-field"><button class="btn btn-secondary" id="billCancelEdit">' +
          'Cancel edit</button></div>'
        : '') +
      '</div>';
  }

  function orderRow(o) {
    var on = !!state.selected[o.id];
    // An order already on another bill stays untickable. While editing this
    // bill its own orders can be ticked, because changing what is on the bill is
    // the whole point of the edit.
    var editable = !o.billed || (state.editing && !!state.editing.orders[o.id]);
    var settled = num(o.balance) <= 0;

    return '<tr' + (editable ? '' : ' class="bill-locked-row"') + '>' +
      '<td class="bill-pick"><input type="checkbox" data-bill-order="' + esc(o.id) + '"' +
        (on ? ' checked' : '') + (editable ? '' : ' disabled') + '></td>' +
      '<td><span class="ord-sub-strong">' + esc(o.code) + '</span>' +
        (o.billed ? ' <span class="chip chip-muted">Billed</span>' : '') +
        (settled ? ' <span class="chip chip-success">Settled</span>' : '') + '</td>' +
      '<td>' + esc(dateLabel(o.order_date)) + '</td>' +
      '<td>' + esc(dateLabel(o.delivery_date)) + '</td>' +
      '<td>' + statusChip(o.status) + '</td>' +
      '<td class="num">' + money(o.total) + '</td>' +
      '<td class="num">' + (num(o.discount) ? '- ' + money(o.discount) : money(0)) + '</td>' +
      '<td class="num">' + money(o.advance) + '</td>' +
      '<td class="num"><strong>' + money(Math.max(0, num(o.balance))) + '</strong></td>' +
      '</tr>';
  }

  function statusChip(status) {
    var kind = {
      'Pending': 'chip-warn',
      'In Progress': 'chip-info',
      'Ready': 'chip-info',
      'Delivered': 'chip-success',
      'Cancelled': 'chip-muted'
    }[status] || 'chip-muted';
    return '<span class="chip ' + kind + '">' + esc(status || 'Pending') + '</span>';
  }

  function summaryCard() {
    var ids = selectedIds();
    if (!ids.length) return '';

    var t = selectedTotals();
    return '<div class="ui-card"><h2 class="ui-card-title">Bill summary</h2>' +
      '<div class="pay-grid">' +
      field('Orders', String(t.count)) +
      field('Total', money(t.total)) +
      field('Discount', '- ' + money(t.discount)) +
      field('Bill amount', money(t.billAmount)) +
      field('Balance due', money(Math.max(0, t.balance))) +
      '</div></div>';
  }

  function field(label, value) {
    return '<div class="ui-field"><label class="ui-label">' + esc(label) + '</label>' +
      '<input class="ui-input bill-ro" value="' + esc(value) + '" readonly></div>';
  }

  function actionCard() {
    var ids = selectedIds();
    var label = state.busy ? 'Saving&hellip;'
      : (state.editing ? 'Update ' + state.editing.code : 'Create bill');

    return '<div class="ui-card"><div class="ui-field ui-field-wide">' +
      '<label class="ui-label" for="billNotes">Bill notes (optional)</label>' +
      '<textarea class="ui-input" id="billNotes" placeholder="Anything to show on the bill">' +
      esc(state.notes) + '</textarea></div>' +
      '<p class="pay-hint">A bill is a statement only. It does not record a payment - ' +
      'money is taken on the Payments page, one order at a time.</p>' +
      '<div class="ord-row-actions">' +
      '<button class="btn btn-primary" id="billSave"' +
        (ids.length && !state.busy ? '' : ' disabled') + '>' + esc(label) + '</button>' +
      '</div></div>';
  }

  function historyCard() {
    if (state.loading) return '';
    if (!state.bills.length) {
      return '<div class="ui-card"><h2 class="ui-card-title">Bill history</h2>' +
        '<div class="empty"><p class="empty-text">No bills yet.</p></div></div>';
    }

    var owner = isOwner();
    return '<div class="ui-card"><h2 class="ui-card-title">Bill history</h2>' +
      '<table class="ui-table"><thead><tr>' +
      '<th>Bill</th><th>Date</th><th class="num">Bill amount</th><th class="num">Balance</th>' +
      '<th>Paid by</th><th>Paid on</th><th></th>' +
      '</tr></thead><tbody>' + state.bills.map(historyRow).join('') + '</tbody></table>' +
      (owner ? '' : '<p class="pay-hint">Editing and archiving a bill is limited to the Owner.</p>') +
      '</div>';
  }

  function historyRow(b) {
    var owner = isOwner();
    // WhatsApp is offered only when there is a real mobile to send to; a
    // button that can only apologise is worse than no button.
    var canShare = !!(window.ANT.whatsapp && state.customer &&
      window.ANT.whatsapp.canSend(state.customer.mobile));
    // A reminder only makes sense on a bill that still owes something. A
    // settled bill would produce a message asking for money already received.
    var canRemind = canShare && num(b.balance) > 0;

    return '<tr>' +
      '<td><span class="ord-sub-strong">' + esc(b.code) + '</span></td>' +
      '<td>' + esc(dateLabel(b.bill_date)) + '</td>' +
      '<td class="num"><strong>' + money(b.bill_amount) + '</strong></td>' +
      '<td class="num">' + money(Math.max(0, num(b.balance))) + '</td>' +
      '<td>' + esc(b.method || '-') + '</td>' +
      '<td>' + esc(dateLabel(b.paid_on)) + '</td>' +
      '<td class="ord-row-actions">' +
      (payLink(b)
        ? '<button class="btn btn-sm btn-primary" data-bill-pay="' + esc(b.id) + '">Pay</button> '
        : '') +
      (canShare
        ? '<button class="btn btn-sm btn-secondary" data-bill-share="' + esc(b.id) + '">WhatsApp</button> '
        : '') +
      (canRemind
        ? '<button class="btn btn-sm btn-secondary" data-bill-remind="' + esc(b.id) + '">Remind</button> '
        : '') +
      '<button class="btn btn-sm btn-secondary" data-bill-print="' + esc(b.id) + '">Print</button>' +
      (owner
        ? ' <button class="btn btn-sm btn-secondary" data-bill-edit="' + esc(b.id) + '">Edit</button>' +
          ' <button class="btn btn-sm btn-secondary" data-bill-archive="' + esc(b.id) + '">Archive</button>'
        : '') +
      '</td></tr>';
  }

  function pager() {
    var pages = Math.max(1, Math.ceil(state.count / PAGE_SIZE));
    if (pages <= 1) return '';

    return '<div class="cust-pager">' +
      '<button class="btn btn-sm btn-secondary" id="billPrev"' +
        (state.page === 0 ? ' disabled' : '') + '>Previous</button>' +
      '<span class="cust-count">Page ' + (state.page + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="billNext"' +
        (state.page + 1 >= pages ? ' disabled' : '') + '>Next</button>' +
      '</div>';
  }

  /* Actions -------------------------------------------------------------- */

  function toggleOrder(id, on) {
    var o = null;
    for (var i = 0; i < state.orders.length; i++) {
      if (state.orders[i].id === id) o = state.orders[i];
    }
    if (!o) return;

    if (on && o.billed && !(state.editing && state.editing.orders[o.id])) {
      toast('Order ' + o.code + ' is already on a bill.', 'error');
      paint();
      return;
    }

    state.selected[id] = !!on;
    paint();
  }

  function openEdit(billId) {
    if (!isOwner()) {
      toast('Only the Owner can edit a bill.', 'error');
      return;
    }

    var bill = null;
    for (var i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === billId) bill = state.bills[i];
    }
    if (!bill) {
      toast('That bill is not on this page.', 'error');
      return;
    }

    sb().from('bill_orders')
      .select('order_id')
      .eq('bill_id', billId)
      .then(function (res) {
        if (res.error) {
          toast('The orders on that bill could not be read: ' + reason(res), 'error');
          return;
        }

        var on = {};
        (res.data || []).forEach(function (row) { on[row.order_id] = true; });

        // Two separate objects on purpose. Ticking and unticking edits
        // state.selected in place, and if that were the same object the edit was
        // keeping as its record of what the bill holds, unticking an order would
        // also drop it from that record - and the row would then lock itself
        // before the edit was even saved.
        var held = {};
        Object.keys(on).forEach(function (k) { held[k] = true; });

        state.selected = on;
        state.editing = { id: bill.id, code: bill.code, orders: held };
        state.notes = bill.notes || '';
        paint();
      });
  }

  function closeEdit() {
    state.editing = null;
    state.selected = {};
    state.notes = '';
    paint();
  }

  function saveBill() {
    var ids = selectedIds();
    if (!ids.length) {
      toast('Select at least one order for the bill.', 'error');
      return;
    }

    var t = selectedTotals();
    var editing = state.editing;

    state.busy = true;
    paint();

    paymentFromOrders(ids)
      .then(function (pay) {
        return editing ? updateBill(editing, ids, t, pay) : createBill(ids, t, pay);
      })
      .then(function (result) {
        state.busy = false;
        if (!result) return;
        if (result.failed) {
          toast(result.message, 'error');
          paint();
          return;
        }

        state.selected = {};
        state.notes = '';
        state.editing = null;
        state.page = 0;
        toast(result.message, 'success');
        return loadOrders().then(loadBills);
      });
  }

  // The code is read, then written. Two people saving at the same moment can read
  // the same next number, so a clash on the unique code is retried once with a
  // fresh number instead of being reported as a failure the user cannot act on.
  function createBill(orderIds, t, pay, retried) {
    return nextCode().then(function (code) {
      return sb().from('bills')
        .insert({
          code: code,
          customer_id: state.customer.id,
          total: t.total,
          discount: t.discount,
          advance: t.advance,
          bill_amount: t.billAmount,
          balance: t.balance,
          bill_date: today(),
          notes: state.notes || '',
          method: pay.method,
          paid_on: pay.paidOn
        })
        .single()
        .then(function (res) {
          if (res.error || !res.data) {
            if (!retried && isDuplicate(res)) {
              return createBill(orderIds, t, pay, true);
            }
            return { failed: true, message: 'The bill was not created: ' + reason(res) };
          }

          return linkOrders(res.data.id, orderIds).then(function (bad) {
            if (!bad) return { message: 'Bill ' + code + ' created.' };

            // A bill with no orders on it bills nothing, so it is taken back out
            // rather than left in the history to be found and wondered about.
            return sb().from('bills')
              .remove()
              .eq('id', res.data.id)
              .then(function () {
                return { failed: true, message: 'The bill was rolled back: ' + bad };
              });
          });
        });
    }).catch(function (e) {
      return { failed: true, message: 'The bill was not created: ' + (e && e.message) };
    });
  }

  function updateBill(editing, orderIds, t, pay) {
    // The bill and the orders on it are read before anything is written, so a
    // failure part way through can put both back. A bill left holding the wrong
    // orders, or the wrong money for the orders it holds, would bill the wrong
    // amount - so the previous state is restored rather than abandoned.
    return sb().from('bills')
      .select('id,total,discount,advance,bill_amount,balance,notes,method,paid_on,bill_date')
      .eq('id', editing.id)
      .limit(1)
      .then(function (snap) {
        if (snap.error || !(snap.data || [])[0]) {
          return { failed: true, message: 'The bill was not updated: ' + reason(snap) };
        }

        var previous = snap.data[0];

        return sb().from('bill_orders')
          .select('order_id')
          .eq('bill_id', editing.id)
          .then(function (before) {
            if (before.error) {
              return { failed: true, message: 'The bill was not updated: ' + reason(before) };
            }

            var heldIds = (before.data || []).map(function (r) { return r.order_id; });

            return sb().from('bills')
              .update({
                total: t.total,
                discount: t.discount,
                advance: t.advance,
                bill_amount: t.billAmount,
                balance: t.balance,
                notes: state.notes || '',
                method: pay.method,
                paid_on: pay.paidOn
              })
              .eq('id', editing.id)
              .then(function (res) {
                // The date on a bill is when it was raised. Editing the orders on
                // it does not make it a new bill, so bill_date is left alone.
                if (res.error || !res.data || !res.data.length) {
                  return { failed: true, message: 'The bill was not updated: ' + reason(res) };
                }

                return sb().from('bill_orders')
                  .remove()
                  .eq('bill_id', editing.id)
                  .then(function (cleared) {
                    if (cleared.error) {
                      return restoreBill(editing.id, previous, heldIds)
                        .then(function (extra) {
                          return {
                            failed: true,
                            message: 'The bill was not updated: ' + reason(cleared) + extra
                          };
                        });
                    }

                    return linkOrders(editing.id, orderIds).then(function (bad) {
                      if (!bad) return null;
                      return restoreBill(editing.id, previous, heldIds)
                        .then(function (extra) {
                          return { failed: true, message: 'The bill was not updated: ' + bad + extra };
                        });
                    });
                  });
              });
          });
      })
      .then(function (result) {
        if (result && result.failed) return result;
        return { message: 'Bill ' + editing.code + ' updated.' };
      })
      .catch(function (e) {
        return { failed: true, message: 'The bill was not updated: ' + (e && e.message) };
      });
  }

  // Puts a bill back the way it was: the orders it was holding, and the money
  // that went with them. The note is appended to the message rather than
  // swallowed, because a bill that only half went back needs a person to look
  // at it.
  function restoreBill(billId, previous, heldIds) {
    return sb().from('bills')
      .update({
        total: previous.total,
        discount: previous.discount,
        advance: previous.advance,
        bill_amount: previous.bill_amount,
        balance: previous.balance,
        notes: previous.notes,
        method: previous.method,
        paid_on: previous.paid_on
      })
      .eq('id', billId)
      .then(function () {
        if (!heldIds.length) return '';
        return sb().from('bill_orders')
          .insert(heldIds.map(function (id) { return { bill_id: billId, order_id: id }; }))
          .then(function (back) {
            return back.error
              ? ' The bill and its orders could not be put back either, so it needs a look.'
              : '';
          });
      });
  }

  // Writes the orders onto a bill. Returns '' when the write worked, or the
  // reason it did not - this function does not try to undo anything itself,
  // because only the caller knows what the state was beforehand. An edit puts
  // both the bill and its orders back through restoreBill; a create has nothing
  // to put back, so the caller takes the empty bill out instead.
  function linkOrders(billId, orderIds) {
    if (!orderIds.length) {
      return Promise.resolve('Select at least one order for the bill.');
    }

    return sb().from('bill_orders')
      .insert(orderIds.map(function (id) {
        return { bill_id: billId, order_id: id };
      }))
      .then(function (res) {
        return res.error ? (res.error.message || 'the orders could not be saved.') : '';
      });
  }

  function archive(billId) {
    if (!isOwner()) {
      toast('Only the Owner can archive a bill.', 'error');
      return;
    }

    sb().from('bills')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', billId)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          toast('The bill could not be archived: ' + reason(res), 'error');
          return;
        }

        toast('Bill archived.', 'success');
        // The bill has left the list, so an edit form still open on it is
        // meaningless. Closing it also puts its orders back under the normal
        // rule, which is that they stay held by the archived bill and cannot be
        // put on a second one.
        if (state.editing && state.editing.id === billId) closeEdit();
        state.page = 0;
        return loadOrders().then(loadBills);
      });
  }

  /* Printing ------------------------------------------------------------- */

  // The legacy printed through Google Drive. This builds the same document in
  // the browser and hands it to the printer, so a bill prints with no server, no
  // Drive account and no wait for an upload.
  //
  // The bill is printed from its own stored figures and its own linked orders,
  // not from whatever happens to be ticked, because a bill is a statement fixed
  // at the moment it was raised.
  function printBill(billId) {
    var bill = null;
    for (var i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === billId) bill = state.bills[i];
    }
    if (!bill) {
      toast('That bill is not on this page.', 'error');
      return;
    }

    sb().from('bill_orders')
      .select('order_id')
      .eq('bill_id', billId)
      .then(function (res) {
        if (res.error) {
          toast('The orders on that bill could not be read: ' + reason(res), 'error');
          return;
        }
        return ordersForPrint((res.data || []).map(function (r) { return r.order_id; }))
          .then(function (list) { openPrintWindow(bill, list); });
      });
  }

  /* Garments for the printed bill.
   *
   * A bill that names only order codes is not much use to the customer holding
   * it: "ORD-14" says nothing about the two shirts they are being charged for.
   * So the items are read and listed under their order.
   *
   * They are decoration, never the bill. If this read fails, is refused, or comes
   * back empty, the order lines print on their own with their own totals. A bill
   * missing a line is worse than one that is less detailed, so nothing here is
   * allowed to hold up or alter the document. */
  function itemsForPrint(ids) {
    if (!ids.length) return Promise.resolve({});

    return sb().from('order_items')
      .select('order_id,category,dress_type,service,variant,lining,quantity,line_total')
      .in('order_id', ids)
      .then(function (res) {
        if (res.error || !res.data) return {};

        var byOrder = {};
        res.data.forEach(function (it) {
          var list = byOrder[it.order_id] || (byOrder[it.order_id] = []);
          list.push(it);
        });
        return byOrder;
      })
      .catch(function () {
        return {};
      });
  }

  function ordersForPrint(ids) {
    if (!ids.length) return Promise.resolve([]);

    var byId2 = {};
    var missing = [];

    ids.forEach(function (id) {
      var hit = null;
      for (var i = 0; i < state.orders.length; i++) {
        if (state.orders[i].id === id) hit = state.orders[i];
      }
      if (hit) byId2[id] = hit;
      else missing.push(id);
    });

    // The orders are resolved first, because the item read needs their ids and a
    // folded-in order may not have been loaded. An order on the bill may also no
    // longer be in the loaded list - one cancelled after the bill was raised, say
    // - and the bill still has to print, so a failed order read is not fatal
    // either.
    var ordersReady = missing.length
      ? sb().from('orders')
          .select('id,code,order_date,delivery_date,total,discount,advance')
          .in('id', missing)
          .then(function (res) {
            (res.data || []).forEach(function (o) { byId2[o.id] = o; });
          })
          .catch(function () { return; })
      : Promise.resolve();

    return ordersReady
      .then(function () {
        return ids.map(function (id) { return byId2[id]; }).filter(Boolean);
      })
      .then(function (list) {
        // The items are attached when they can be read and left empty when they
        // cannot. Either way the list comes back, so the caller never has to
        // decide whether a failure here should stop a bill from printing.
        return itemsForPrint(list.map(function (o) { return o.id; })).then(function (byOrder) {
          list.forEach(function (o) {
            o.items = byOrder[o.id] || [];
          });
          return list;
        });
      });
  }

  /* The printed bill -------------------------------------------------------
   *
   * A bill is the shop's invoice, and it is usually kept: filed, photographed,
   * sent on WhatsApp, or handed over with the garment. So it is laid out to be
   * read once and filed, not skimmed at the counter.
   *
   * What a customer of a tailoring shop actually needs from it:
   *
   *   - to recognise it as the shop's, at a glance, in a pile of paperwork
   *   - to find it again later by the bill number and the date
   *   - to see WHAT was made for them, not just which order codes went on it
   *   - to see what is still owed, unambiguously
   *   - to have somewhere to sign
   *
   * The order codes alone did not answer the third of those. A bill reading
   * "ORD-14, 1,200" tells the customer nothing about the two shirts and the
   * blouse they are being charged for, and it is the single most common question
   * at the counter. So the garment lines are listed under each order, when the
   * items can be read, and the order code stays as the heading that ties the
   * bill to the shop's records.
   *
    * If an item cannot be read the order still prints, with its own total,
    * because a bill short of a row is worse than one that is less detailed.
    */

  var PRINT_CSS = [
    '*{box-sizing:border-box}',
    'body{font:12.5px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;color:#1f2937;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.bill{width:190mm;margin:0;padding:4mm;border:2px solid #0f2239;border-radius:2px}',
'.bill::after{content:"";position:absolute;inset:2mm;border:1px solid #b08d3f;pointer-events:none}',
'.bill{position:relative}',

    '.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:4mm;padding-bottom:4mm;border-bottom:3px double #0f2239}',
    '.brand{display:flex;align-items:center;gap:3mm;min-width:0;flex:1 1 60mm}',
    '.shop-logo{width:22mm;height:22mm;object-fit:contain;flex:0 0 auto;border-radius:50%;border:2px solid #b08d3f;padding:1mm}',
    '.shop-name{font-family:Georgia,"Times New Roman",serif;font-size:18px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;line-height:1.1;color:#0f2239}',
    '.shop-sub{font-size:8px;color:#5c4821;margin-top:.8mm;letter-spacing:.03em;font-weight:600;text-transform:uppercase}',

    '.bill-bar{display:flex;gap:0;margin:4mm 0 0;padding:3mm 2mm;background:#0f2239;border-radius:3px}',
    '.bill-bar-item{flex:1 1 0;min-width:0;text-align:center;border-right:1px solid rgba(255,255,255,.15)}',
    '.bill-bar-item:last-child{border-right:none}',
    '.bill-bar-label{font-size:7.5px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#d8c293}',
    '.bill-bar-val{font-size:12px;font-weight:600;color:#ffffff;margin-top:.8mm;letter-spacing:.04em}',

    '.parties{display:flex;gap:8mm;margin:5mm 0 4mm}',
    '.party{flex:1 1 0;min-width:0;border:1px solid #d4c9a8;border-radius:3px;padding:3mm 3.5mm;background:#fffdf7}',
    '.party-label{font-size:8px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#b08d3f;padding-bottom:1.2mm;margin-bottom:2mm;border-bottom:1px solid #e8e0c8}',
    '.party-line{font-size:10.5px;color:#374151;margin-top:1.2mm;word-break:break-word}',
    '.party-line b{color:#0f2239;font-weight:600}',

    'table{width:100%;border-collapse:collapse;margin:3mm 0 0;table-layout:fixed}',
    'th{font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ffffff;text-align:left;padding:2mm 1.2mm;background:#0f2239;white-space:nowrap}',
    'td{font-size:11px;padding:2mm 1.2mm;border-bottom:1px solid #e8e0c8;vertical-align:top;word-wrap:break-word;overflow-wrap:break-word}',
    'tbody tr:nth-child(even) td{background:#faf8f3}',
    'th.r,td.r{text-align:right;white-space:nowrap}',
    '.item-name{font-weight:500;color:#1f2937}',
    '.item-note{font-size:9px;color:#6b7280;margin-top:.4mm;letter-spacing:.02em}',

    '.totals{margin:5mm 0 0 auto;width:70mm}',
    '.totals div{display:flex;justify-content:space-between;gap:5mm;padding:1.6mm 2mm;font-size:11px}',
    '.totals .label{color:#374151}',
    '.totals .val{font-variant-numeric:tabular-nums;white-space:nowrap;color:#0f2239;font-weight:600}',
    '.totals .sub{border-top:1px solid #d4c9a8;margin-top:1mm;padding-top:2mm;font-weight:600}',
    '.totals .due{border-top:2px solid #b08d3f;border-bottom:2px solid #b08d3f;background:#fdf8ed;margin-top:1.6mm;padding:2.6mm 2mm;font-size:13.5px;font-weight:700}',
    '.totals .due .label{color:#0f2239;font-weight:700;letter-spacing:.02em}',
    '.totals .due .val{color:#0f2239}',

    '.words{font-size:10px;margin:5mm 0 0;padding:2.2mm 0 0;border-top:1px solid #e8e0c8;color:#374151;letter-spacing:.01em;white-space:normal;word-wrap:break-word}',
    '.words b{font-weight:600;color:#0f2239}',

    '.blocks{display:flex;flex-wrap:wrap;gap:4mm;align-items:stretch;margin-top:6mm}',
    '.pay{position:relative;display:flex;gap:3mm;align-items:center;background:#fffdf7;border:1px solid #d4c9a8;border-left:3mm solid #b08d3f;border-radius:3px;padding:3mm 3.5mm 3mm 4mm;flex:1 1 auto;min-width:0;page-break-inside:avoid;break-inside:avoid}',
    '.pay-ribbon{position:absolute;top:-2.6mm;left:4mm;background:#b08d3f;color:#fff8e8;font-size:7px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;padding:.8mm 2.2mm;border-radius:2px}',
    '.qr-plate{background:#ffffff;border:1px solid #e8e0c8;border-radius:2px;padding:1.6mm;flex:0 0 auto;display:block}',
    '.qr{width:26mm;height:26mm;display:block}',
    '.pay-text{font-size:10.5px;min-width:0}',
    '.pay-head{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:12.5px;margin-bottom:.6mm;color:#0f2239}',
    '.pay-amt{font-family:Georgia,"Times New Roman",serif;font-size:15px;font-weight:700;color:#b08d3f;letter-spacing:.02em;margin:.4mm 0 1mm}',
    '.pay-link{display:inline-block;margin:0 0 1mm;color:#0f3460;font-weight:600;word-break:break-all;text-decoration:none;border-bottom:.4mm solid #d4c9a8}',
    '.pay-id{color:#6b7280;font-size:10px;letter-spacing:.02em}',
    '.follow{position:relative;flex:0 1 auto;display:flex;gap:2mm;align-items:center;background:#0f2239;color:#f4f1e8;border-radius:3px;padding:2.5mm 3mm;page-break-inside:avoid;break-inside:avoid}',
    '.follow .qr-plate{border-color:#3a4a6e;background:#ffffff}',
    '.follow .qr{width:16mm;height:16mm}',
    '.follow-text{min-width:0}',
    '.follow-head{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:9px;color:#ffffff;display:flex;align-items:center;gap:1mm}',
    '.follow-glyph{flex:0 0 auto;display:block}',
    '.follow-link{display:inline-block;margin:.5mm 0 .2mm;color:#f0d9a0;font-weight:600;word-break:break-all;text-decoration:none;border-bottom:.4mm solid #4a5a80}',
    '.follow-id{font-size:7.5px;color:#a9b4c9;letter-spacing:.05em;text-transform:uppercase}',

    '.notes{margin:4mm 0 0;font-size:10.5px;padding:2.4mm 3mm;background:#f7f4ea;border-left:2px solid #b08d3f;color:#374151}',

    /* Reference frame - ornate gold double border with corner flourishes --- */
    '.bill{border:2px solid #b8934f;border-radius:2mm;padding:4.5mm;background:#fffdf7}',
    '.bill::before{content:"";position:absolute;inset:1.6mm;border:1px solid #cdb894;pointer-events:none}',
    '.bill::after{display:none}',
    '.cnr{position:absolute;width:11mm;height:11mm;border:1.6px solid #b8934f;border-radius:50%;border-right:none;border-bottom:none;z-index:1}',
    '.cnr.tl{top:1.6mm;left:1.6mm}',
    '.cnr.tr{top:1.6mm;right:1.6mm;transform:rotate(90deg)}',
    '.cnr.bl{bottom:1.6mm;left:1.6mm;transform:rotate(-90deg)}',
    '.cnr.br{bottom:1.6mm;right:1.6mm;transform:rotate(180deg)}',

    '.head{display:flex;align-items:flex-start;justify-content:space-between;gap:4mm;padding-bottom:3mm;border-bottom:none;flex-wrap:nowrap}',
    '.mastlogo{flex:0 0 auto}',
    '.mastcenter{flex:1 1 auto;min-width:0;text-align:center}',
    '.shop-logo{width:26mm;height:26mm;border:2px solid #b8934f;padding:1mm;background:#fff}',
    '.shop-name{font-size:19px;letter-spacing:.22em;color:#22314f}',
    '.shop-sub{color:#b8934f;letter-spacing:.28em}',
    '.shop-contact{font-size:9px;color:#5a5346;margin-top:1.2mm;letter-spacing:.03em;text-transform:none}',
    '.orn{display:flex;align-items:center;justify-content:center;margin:2.8mm 0 0}',
    '.orn::before,.orn::after{content:"";width:32mm;height:1px;background:#cdb894;flex:0 0 auto}',
    '.orn span{width:4.4mm;height:4.4mm;border:1.3px solid #b8934f;border-radius:50%;margin:0 2.4mm;flex:0 0 auto}',
    '.stamp{position:absolute;bottom:14mm;right:18mm;padding:2mm 6mm;transform:rotate(-12deg);border:2px solid;border-radius:2px;font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;z-index:2;box-shadow:0 2px 5px rgba(0,0,0,0.12)}',
    '.stamp-paid{color:#155724;border-color:#155724;background:#d4edda}',
    '.stamp-part{color:#856404;border-color:#856404;background:#fff3cd}',
    '.stamp-due{color:#721c24;border-color:#721c24;background:#f8d7da}',

    '.bill-bar{margin:3mm 0 2mm;padding:2.2mm 0;background:none;border:none;border-top:1px solid #cdb894;border-bottom:1px solid #cdb894;border-radius:0}',
    '.bill-bar-item{border-right:none}',
    '.bill-bar-item + .bill-bar-item{border-left:1px solid #e6d9bd}',
    '.bill-bar-label{color:#b8934f;letter-spacing:.22em}',
    '.bill-bar-val{color:#22314f}',

    '.sect{display:flex;align-items:center;gap:1.8mm;font-size:8.5px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:#b8934f;margin:3.4mm 0 2mm}',
    '.sect::before{content:"";width:5px;height:5px;background:#b8934f;transform:rotate(45deg);flex:0 0 auto}',
    '.parties{display:flex;gap:4mm;align-items:stretch}',
    '.cdetails{flex:1 1 58%;min-width:0;border:1px solid #e0d3af}',
    '.c-row{display:flex;padding:1.4mm 2.4mm;font-size:10.5px;border-bottom:1px solid #f0e9d8}',
    '.c-row:last-child{border-bottom:none}',
    '.c-row span{flex:0 0 30mm;color:#9a8a5f;letter-spacing:.14em;text-transform:uppercase;font-size:7.5px;padding-top:.6mm}',
    '.c-row b{color:#22314f;font-weight:600}',
    '.caddr{flex:1 1 42%;min-width:0;border:1px solid #e0d3af}',
    '.caddr-label{font-size:7.5px;letter-spacing:.26em;text-transform:uppercase;color:#b8934f;font-weight:700;padding:1.4mm 2.4mm;border-bottom:1px solid #f0e9d8}',
    '.caddr-val{padding:1.6mm 2.4mm;font-size:10.5px;color:#22314f;min-height:16mm}',

    'table{margin:2.6mm 0 0}',
    'th{background:#22314f;color:#fffdf7;border:1px solid #22314f}',
    'td{border:1px solid #dcd0ae}',
    'th,td{padding:1.7mm 1.4mm;font-size:10px}',

    '.midrow{display:flex;gap:4mm;align-items:stretch}',
    '.paycard{flex:1 1 58%;min-width:0;border:1px solid #d9cba6}',
    '.paycard-title{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:#b8934f;font-weight:700;padding:1.6mm 2.4mm;border-bottom:1px solid #e6d9bd}',
    '.payrow{display:flex;justify-content:space-between;padding:1.5mm 2.4mm;font-size:10.5px;border-bottom:1px solid #f0e9d8}',
    '.payrow span{color:#9a8a5f;letter-spacing:.14em;text-transform:uppercase;font-size:7.5px;padding-top:.6mm}',
    '.payrow b{color:#22314f}',
    '.scanbox{display:flex;gap:3mm;margin:2mm 2.4mm 2.4mm;padding:2.2mm;background:#fbf7ec;border:1px solid #e8ddbf;align-items:center}',
    '.scanbox .qr{width:18mm;height:18mm}',
    '.scanbox .qr-plate{background:#ffffff;border:1px solid #e0d3af;padding:1.4mm}',
    '.scanbox-text .pay-amt{font-family:Georgia,"Times New Roman",serif;font-size:13px;font-weight:700;color:#b8934f;margin:.8mm 0}',
    '.scanbox-head{font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:#b8934f;font-weight:700}',
    '.totals{margin:0;width:auto;flex:1 1 42%;border:1px solid #d9cba6}',
    '.totals .due{background:#fbf6ea}',
    '.words{margin:5mm 0 0;padding:2.2mm 0 0;border-top:1px solid #e8e0c8}',

    '.footmast{text-align:center;margin-top:5mm}',
    '.fm-name{font-family:Georgia,"Times New Roman",serif;font-size:15px;letter-spacing:.3em;color:#22314f;text-transform:uppercase;font-weight:700}',
    '.fm-tag{font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:9.5px;color:#b8934f;margin-top:.8mm}',
    '.fm-contact{font-size:8.5px;color:#555;margin-top:1.4mm;letter-spacing:.06em}',
    '.fm-handle{font-size:8.5px;color:#22314f;font-weight:700;margin-top:.8mm}',
    '.fm-rule{height:1px;background:#cdb894;margin:3mm 8mm 0}',
    '.fm-line{margin-top:2mm;font-size:8px;letter-spacing:.3em;text-transform:uppercase;color:#8a7a54}',

    '.follow{position:static;flex:0 0 auto;width:auto;display:block;background:#ffffff;color:#22314f;border:1px solid #cdb894;border-radius:3mm;padding:1.6mm;text-align:center;box-shadow:0 2px 5px rgba(0,0,0,.08)}',
    '.follow .qr-plate{border:none;background:#ffffff;margin:0 auto;display:inline-block}',
    '.follow .qr{width:12mm;height:12mm}',
    '.follow-text{margin-top:1.4mm;text-align:center;width:100%}',
    '.follow-head{justify-content:center;font-size:7px;letter-spacing:.25em;color:#b8934f;text-align:center;width:100%}',
    '.follow-link{display:block;color:#22314f;font-size:8px;margin-top:1mm;text-align:center}',
    '.follow-id{color:#8a8676;font-size:6.5px;text-align:center;width:100%}',
    '',

    '@media print{body{margin:0;padding:0}',
    '.bill{transform-origin:top left}',

    '}',
    'thead{display:table-header-group}',
    'tr{page-break-inside:avoid;break-inside:avoid}'
  ].join('');

  // Indian numbering reads in thousands, lakhs and crores, not millions and
  // billions, so the total is written the way the shop's customer reads it.
  var WORD_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
    'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'];
  var WORD_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy',
    'Eighty', 'Ninety'];

  function twoDigits(n) {
    if (n < 20) return WORD_ONES[n];
    return WORD_TENS[Math.floor(n / 10)] +
      (n % 10 ? ' ' + WORD_ONES[n % 10] : '');
  }

  function threeDigits(n) {
    var h = Math.floor(n / 100);
    var rest = n % 100;
    return (h ? WORD_ONES[h] + ' Hundred' : '') + (rest ? (h ? ' ' : '') + twoDigits(rest) : '');
  }

  /* The bill amount in words, because an Indian invoice is expected to carry one
   * and a crossed-out cheque is written on it. Only whole rupees are worded;
   * paise are named in figures underneath, which is what a shop does in
   * practice and avoids the awkwardness of "and Fifty Paise Only" on every bill
   * that happens to end in 50p.
   *
   * Every part is asserted in the harness. A wrong word here is worse than no
   * word at all, because it is read as a statement of fact. */
  function amountInWords(value) {
    var paise = Math.round((num(value) - Math.floor(num(value))) * 100);
    // The whole-rupee total, kept as its own variable. The decomposition below
    // reduces its working copy to the part under a thousand, so reading "how many
    // rupees" off that copy later would mistake 1,001 for a single rupee.
    var totalRupees = Math.floor(num(value));

    if (totalRupees <= 0 && paise <= 0) return 'Zero Rupees Only';

    var parts = [];

    function upto(n, name) {
      var text = threeDigits(n);
      if (text) parts.push(text + ' ' + name);
    }

    var rest = totalRupees;
    var crore = Math.floor(rest / 10000000);
    rest %= 10000000;
    var lakh = Math.floor(rest / 100000);
    rest %= 100000;
    var thousand = Math.floor(rest / 1000);
    rest %= 1000;

    upto(crore, 'Crore');
    upto(lakh, 'Lakh');
    upto(thousand, 'Thousand');
    upto(rest, '');

    var words = parts.join(' ').replace(/\s+/g, ' ').trim();
    // One rupee is "One Rupee". A bill that says "One Rupees Only" is a small
    // thing, but it is a document somebody writes a payment amount from.
    return words + (totalRupees === 1 ? ' Rupee Only' : ' Rupees Only');
  }

  // The paise, named in figures, because that is where a shop puts them rather
  // than trying to word a decimal. 0 is blank so a whole-rupee bill has nothing
  // trailing after "Rupees Only".
  function paiseOf(value) {
    var p = Math.round((num(value) - Math.floor(num(value))) * 100);
    return p > 0 ? String(p) : '';
  }

  function openPrintWindow(bill, list) {
    var c = state.customer;
    if (!c) {
      toast('Open a customer first, then print a bill.', 'error');
      return;
    }

    // The size only lays the page out; it never touches a figure on it.
    var size = window.ANT.printsize.normalize(state.shop.printSize);

    var shopName = state.shop.name || 'AN TAILOR';
    var due = Math.max(0, num(bill.balance));
    var settled = due <= 0;
    // Part-paid is its own state because it is the one that needs chasing, and a
    // stamp that only distinguishes paid from unpaid would call it settled.
    var partial = !settled && num(bill.advance) > 0;
    // The angled status stamp that a counter hand-over carries. Professional
    // bills never use a floating text line for this; a stamp is unambiguous.
    var stampText = settled ? 'Paid' : (partial ? 'Part Paid' : 'Payment Due');

    // The items are optional decoration, so a bill never waits on them and a read
    // that failed simply leaves the order to print on its own.
    var rows = list.map(function (o, oi) {
      var items = (o.items || []).map(function (it, idx) {
        var note = [];
        if (it.variant) note.push(it.variant);
        if (it.lining) note.push(it.lining + ' lining');
        if (it.service && it.service !== 'Tailoring') note.push(it.service);

        return '<tr>' +
          '<td class="r">' + esc(String(idx + 1)) + '</td>' +
          '<td class="r">' + esc(o.code) + '</td>' +
          '<td class="item">' +
            '<div class="item-name">' +
              esc(it.dress_type || it.category || 'Garment') + '</div>' +
            (note.length ? '<div class="item-note">' + esc(note.join(' · ')) + '</div>' : '') +
          '</td>' +
          '<td class="r">' + esc(dateLabel(o.delivery_date)) + '</td>' +
          '<td class="r">' + esc(String(it.quantity == null ? '' : it.quantity)) + '</td>' +
          '<td class="r">' + money(it.line_total) + '</td>' +
          '<td class="r">' + money(0) + '</td>' +
          '<td class="r">' + money(it.line_total) + '</td>' +
        '</tr>';
      }).join('');

      if (!items) {
        items = '<tr><td colspan="8" class="item-note">' +
          'No garments are listed for this order.' +
          (o.code ? ' (Order ' + esc(o.code) + '.)' : '') +
        '</td></tr>';
      }

      return items;
    }).join('');

    if (!list.length) {
      rows = '<tr><td colspan="8" class="item-note">No orders are recorded on this bill.</td></tr>';
    }

    // A UPI code is drawn only when a real amount is still owed and the shop
    // has a valid id configured. payLink() is the same builder the on-screen Pay
    // button uses, so a settled bill cannot print a code inviting the customer
    // to pay twice and the two can never name different accounts.
    var target = payLink(bill);
    var payBlock = '';

    if (target && window.ANT.qr) {
      var dueLabel = money(window.ANT.upi.balanceDue(bill));

      payBlock = '<div class="paycard">' +
        '<div class="paycard-title">Payment Details</div>' +
        '<div class="payrow"><span>Payment Method</span><b>' + esc(bill.method || '-') + '</b></div>' +
        (bill.paid_on
          ? '<div class="payrow"><span>Payment Date</span><b>' + esc(dateLabel(bill.paid_on)) + '</b></div>'
          : '') +
        '<div class="scanbox">' +
          '<span class="qr-plate">' +
            window.ANT.qr.svg(target, {
              className: 'qr',
              border: 1,
              dark: '#000000',
              light: '#ffffff',
              label: 'Scan to pay ' + dueLabel + ' to ' + (state.shop.name || 'AN TAILOR')
            }) +
          '</span>' +
          '<div class="scanbox-text">' +
            '<div class="scanbox-head">Scan &amp; Pay</div>' +
            '<div class="pay-id">UPI ID: ' + esc(state.shop.upiId || '') + '</div>' +
            '<div class="pay-amt">Pay ' + esc(dueLabel) + '</div>' +
            '<a class="pay-link" href="' + esc(target) + '">Tap to Pay ' + esc(dueLabel) + '</a>' +
            '<div class="pay-id">Any UPI app</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    // The Instagram QR is off by default: it prints only when the shop has put a
    // handle in Settings. Like the pay code, the URL is rebuilt from the stored
    // username so the code and the printed handle can never point at different
    // profiles.
    var igTarget = instagramUrl();
    var followBlock = '';

    if (igTarget && window.ANT.qr) {
      followBlock = '<div class="follow">' +
        '<span class="qr-plate">' +
          window.ANT.qr.svg(igTarget, {
            className: 'qr',
            border: 1,
            dark: '#000000',
            light: '#ffffff',
            label: 'Scan to follow @' + state.shop.instagram + ' on Instagram'
          }) +
        '</span>' +
        '<div class="follow-text">' +
          '<div class="follow-head">' +
            '<svg class="follow-glyph" width="13" height="13" viewBox="0 0 24 24" ' +
              'fill="none" stroke="#f0d9a0" stroke-width="2" aria-hidden="true">' +
              '<rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/>' +
              '<circle cx="12" cy="12" r="4.2"/>' +
              '<circle cx="17.6" cy="6.4" r="1.15" fill="#f0d9a0" stroke="none"/>' +
            '</svg>' +
            'Follow Us' +
          '</div>' +
          '<a class="follow-link" href="' + esc(igTarget) + '">@' +
            esc(state.shop.instagram) + '</a>' +
          '<div class="follow-id">Scan to connect</div>' +
        '</div>' +
      '</div>';
    }

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' +
      esc(bill.code) + ' ' + esc(shopName) + '</title><style>' +
      PRINT_CSS +
      window.ANT.printsize.pageCss(size) +
      window.ANT.printsize.layoutCss(size) +
      '</style></head><body>' +
      '<div class="bill' + (size === 'A4HALF' ? ' bill-half' : '') + '">' +
        '<div class="stamp stamp-' + (settled ? 'paid' : (partial ? 'part' : 'due')) + '">' + esc(stampText) + '</div>' +
      '<div class="head">' +
        '<div class="mastlogo"><img class="shop-logo" src="' + esc(logoUrl()) + '" alt="" ' +
          'onerror="this.remove()"></div>' +
        '<div class="mastcenter">' +
          '<div class="shop-name">' + esc(shopName) + '</div>' +
          '<div class="shop-sub">Professional Tailoring Services</div>' +
          (state.shop.address
            ? '<div class="shop-contact">' + esc(state.shop.address) + '</div>'
            : '') +
          ((state.shop.phone || state.shop.email)
            ? '<div class="shop-contact">' +
              (state.shop.phone ? 'Mobile: ' + esc(state.shop.phone) : '') +
              (state.shop.phone && state.shop.email ? ' &nbsp;&middot;&nbsp; ' : '') +
              (state.shop.email ? 'Email: ' + esc(state.shop.email) : '') +
              '</div>'
            : '') +
        '</div>' +
        followBlock +
      '</div>' +
      '<div class="orn"><span></span></div>' +

      '<div class="bill-bar">' +
        '<div class="bill-bar-item">' +
          '<div class="bill-bar-label">Bill No</div>' +
          '<div class="bill-bar-val">' + esc(bill.code) + '</div>' +
        '</div>' +
        '<div class="bill-bar-item">' +
          '<div class="bill-bar-label">Bill Date</div>' +
          '<div class="bill-bar-val">' + esc(dateLabel(bill.bill_date)) + '</div>' +
        '</div>' +
        '<div class="bill-bar-item">' +
          '<div class="bill-bar-label">Delivery Date</div>' +
          '<div class="bill-bar-val">' + esc(dateLabel(list[0] && list[0].delivery_date)) + '</div>' +
        '</div>' +
        '<div class="bill-bar-item">' +
          '<div class="bill-bar-label">Status</div>' +
          '<div class="bill-bar-val">' +
            (settled ? 'Paid' : (partial ? 'Part paid' : 'Payment due')) +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="sect">Customer Details</div>' +
      '<div class="parties">' +
        '<div class="cdetails">' +
          '<div class="c-row"><span>Customer ID</span><b>' + esc(c.code || '-') + '</b></div>' +
          '<div class="c-row"><span>Customer Name</span><b>' + esc(c.name) + '</b></div>' +
          '<div class="c-row"><span>Mobile No</span><b>' + esc(c.mobile || '-') + '</b></div>' +
        '</div>' +
        (c.address
          ? '<div class="caddr"><div class="caddr-label">Address</div><div class="caddr-val">' +
            esc(c.address) + '</div></div>'
          : '') +
      '</div>' +

      '<table><thead><tr>' +
        '<th style="width:6%">S.No</th><th style="width:14%">Order ID</th><th style="width:22%">Dress Type</th>' +
        '<th style="width:14%">Delivery Date</th>' +
        '<th class="r" style="width:8%">Qty</th><th class="r" style="width:12%">Rate</th>' +
        '<th class="r" style="width:10%">Disc</th><th class="r" style="width:14%">Amount</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

      '<div class="midrow">' +
        payBlock +
        '<div class="totals">' +
          '<div><span class="label">Sub Total</span><span class="val">' + money(bill.total) + '</span></div>' +
          (num(bill.discount)
            ? '<div><span class="label">Discount</span><span class="val">- ' +
              money(bill.discount) + '</span></div>'
            : '') +
          '<div class="sub"><span class="label">Total Amount</span><span class="val">' +
            money(bill.bill_amount) + '</span></div>' +
          '<div><span class="label">Total Paid</span><span class="val">' + money(bill.advance) + '</span></div>' +
          '<div class="due"><span class="label">Balance Amount</span><span class="val">' +
            money(due) + '</span></div>' +
        '</div>' +
      '</div>' +



      (bill.notes ? '<div class="notes">' + esc(bill.notes) + '</div>' : '') +

      '</div>' +
      '</body></html>';

    var win = window.open('', '_blank');
    if (!win) {
      toast('Please allow pop-ups to print the bill.', 'error');
      return;
    }

    win.document.open();
    win.document.write(html);
    win.document.close();

    var go = function () {
      // The bill is fitted to one page first. Fitting needs a laid-out document
      // and the logo is an image, so it waits for the window to finish loading
      // before it measures. Any failure here leaves the bill unscaled, which still
      // prints correctly - a bill that runs onto a second page is a nuisance, a
      // bill that does not print at all is a lost sale.
      try {
        fitToOnePage(win, window.ANT.printsize.pageHeightMm(size),
          window.ANT.printsize.billWidthMm(size));
      } catch (e) {
        // Measured nothing; print it as it stands.
      }

      try {
        win.focus();
        win.print();
      } catch (e) {
        return;
      }
    };

    if (win.document.readyState === 'complete') setTimeout(go, 250);
    else win.onload = function () { setTimeout(go, 250); };
  }

  /* One page, whatever the bill carries ------------------------------------- */

  /* Shrinks a printed bill until it fits the sheet, and never enlarges one that
   * already fits.
   *
   * A bill has no fixed length: four garments fit comfortably, forty do not, and
   * the same shop is small today and busy at Diwali. Left alone the browser
   * prints the overflow onto a second page, and a customer holding two half bills
   * is a customer who loses one. So the document is measured against the real
   * printable area and scaled down to fit.
   *
   * How it is done, and why this way:
   *
   *   - The measuring window is narrowed to the printed width first. Measuring in
   *     the popup as the browser happens to have sized it would wrap the garment
   *     names differently from the way they wrap on the sheet, so the fit would be
   *     calculated against a layout the printer never sees.
   *   - The scale is applied as zoom rather than as a CSS transform. A transform
   *     shrinks the pixels but leaves the element's layout height alone, so the
   *     document still thinks it is taller than the page and the browser still
   *     breaks it. zoom changes both, which is what "fit to one page" needs.
   *   - It only ever scales down. A short bill printing larger than it was drawn
   *     would be a surprise, and would change how the shop's own templates look.
   *   - The floor stops it becoming unreadable. Below 62% the garment names are no
   *     longer legible on a counter, and an unreadable bill is not a bill; past
   *     that point the overflow goes to a second page on purpose, because a
   *     second page is a smaller problem than a bill nobody can read.
   *   - Images are awaited, because the logo is a fixed 36mm box reserved in the
   *     layout. Measuring before it resolves would under-read the height and
   *     choose a scale that is too large.
   *
   * Returns the scale it settled on, or 1 when the bill already fitted, so the
   * behaviour can be asserted rather than taken on trust. */
  var MIN_SCALE = 0.62;

  function fitToOnePage(win, pageHeightMm, billWidthMm) {
    var doc = win.document;
    if (!doc || !doc.body) return 1;

    var bill = doc.querySelector('.bill');
    if (!bill) return 1;

    // Millimetres to pixels for this document. A 100mm probe is measured rather
    // than computed from a hardcoded 3.78px/mm, because the browser's own
    // conversion is the one the printer will use.
    var probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:100mm;width:0';
    doc.body.appendChild(probe);
    var pxPerMm = probe.getBoundingClientRect().height / 100;
    doc.body.removeChild(probe);

    if (!(pxPerMm > 0)) return 1;

    var targetPx = pageHeightMm * pxPerMm;
    var widthPx = billWidthMm * pxPerMm;

    // The window is set to the printed width so the wrapping being measured is
    // the wrapping that will print. It is restored afterwards so the tailor is
    // left looking at a normal-sized document.
    var body = doc.body;
    var prevWidth = body.style.width;
    var prevZoom = body.style.zoom;
    body.style.width = widthPx + 'px';

    try {
      // The zoom is cleared rather than set to 1 so a bill that turns out to fit
      // is left exactly as it was written. A stray zoom on the element is a
      // difference between the document that was built and the one that prints.
      bill.style.zoom = '';

      var height = bill.getBoundingClientRect().height;
      if (!(height > targetPx)) return 1;

      var scale = targetPx / height;
      if (scale < MIN_SCALE) scale = MIN_SCALE;
      if (scale >= 1) return 1;

      bill.style.zoom = String(scale);
      return scale;
    } finally {
      body.style.width = prevWidth;
      if (prevZoom) body.style.zoom = prevZoom;
      else body.style.zoom = '';
    }
  }

  /* Taking a payment ------------------------------------------------------- */

  // The shop logo, as a URL the printed window can resolve. The print view is
  // written into a blank document, where a relative "assets/ANTailor.png" would
  // be resolved against about:blank and come back broken, so the path is made
  // absolute here. The image removes itself if the file is not there, leaving the
  // shop name as the letterhead.
  function logoUrl() {
    try {
      return new URL('assets/ANTailor.png', window.location.href).href;
    } catch (e) {
      return 'assets/ANTailor.png';
    }
  }

  // The profile the QR opens. Built from the bare username so that whatever the
  // shop typed in Settings - an @handle or a pasted link - ends at the same URL.
  function instagramUrl() {
    return state.shop.instagram
      ? 'https://www.instagram.com/' + encodeURIComponent(state.shop.instagram)
      : '';
  }

  /* The one place a UPI intent is built, so the Pay button and the printed QR
   * can never disagree about the account or the amount. Returns '' when there is
   * nothing owed or no usable id, which is also how the Pay button knows to stay
   * off the row. */
  function payLink(bill) {
    if (!window.ANT.upi) return '';

    return window.ANT.upi.link({
      vpa: state.shop.upiId,
      payee: state.shop.payee || state.shop.name || 'AN TAILOR',
      amount: window.ANT.upi.balanceDue(bill),
      note: bill.code
    });
  }

  /* A upi:// intent is only handed to the phone by clicking a real anchor.
   * Assigning it to location.href instead would either leave the shop staring
   * at a "no app found" page or, worse, unload the app mid-order, because the
   * app has no way to tell the browser it meant to come back. */
  function openUpi(target) {
    var a = document.createElement('a');
    a.href = target;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    /* Nothing opened the link: no UPI app installed, or the browser ignored the
     * scheme. The page is still in front a moment later, so say what to do
     * instead of leaving a button that looks broken. */
    setTimeout(function () {
      if (document.visibilityState !== 'hidden') {
        toast('No UPI app opened. Ask the customer to scan the printed QR, ' +
          'or pay to ' + state.shop.upiId + '.', 'error');
      }
    }, 1500);

    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 100);
  }

  function payNow(billId) {
    var bill = state.bills.filter(function (b) { return b.id === billId; })[0];
    var target = bill ? payLink(bill) : '';

    if (!target) {
      toast(state.shop.upiId
        ? 'There is nothing left to pay on this bill.'
        : 'No UPI ID is set yet. Add it in Settings.', 'error');
      return;
    }

    openUpi(target);
  }

  /* Sending a bill on WhatsApp ---------------------------------------------- */

  /* wa.me with the message already filled in. Handed over by clicking a real
   * anchor rather than assigning to location, so the app is not navigated away
   * from and the tailor comes back to the same screen. Opened in a new tab,
   * because on a computer wa.me is WhatsApp Web and the bill should not take
   * the shop's own screen with it. */
  function openChat(url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 100);
  }

  /* The message is built from the same bill the Print button draws, so the two
   * can never quote different orders or a different balance. The orders are
   * read fresh from bill_orders, exactly as printing does, because a bill's
   * orders are the record and the loaded order list may not hold them all.
   *
   * The bill and the reminder share this one path on purpose. Two copies of
   * this code would eventually quote different figures for the same bill, and
   * the customer would be the one to notice. */
  function sendBillMessage(billId, kind) {
    if (!window.ANT.whatsapp) return;

    var c = state.customer;
    if (!c) {
      toast('Open a customer first, then send a bill.', 'error');
      return;
    }
    if (!window.ANT.whatsapp.canSend(c.mobile)) {
      toast('This customer has no mobile number to send WhatsApp to. ' +
        'Add one on the Customers page.', 'error');
      return;
    }

    var bill = null;
    for (var i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === billId) bill = state.bills[i];
    }
    if (!bill) {
      toast('That bill is not on this page.', 'error');
      return;
    }

    sb().from('bill_orders')
      .select('order_id')
      .eq('bill_id', billId)
      .then(function (res) {
        if (res.error) {
          toast('The orders on that bill could not be read: ' + reason(res), 'error');
          return;
        }

        return ordersForPrint((res.data || []).map(function (r) { return r.order_id; }))
          .then(function (list) {
            var args = { shop: state.shop, customer: c, bill: bill, orders: list };

            var message = kind === 'reminder'
              ? window.ANT.whatsapp.reminderMessage(args)
              : window.ANT.whatsapp.billMessage(args);

            var url = window.ANT.whatsapp.link(c.mobile, message);
            if (!url) {
              toast('That mobile number is not one WhatsApp can use.', 'error');
              return;
            }

            openChat(url);
            toast('Opening WhatsApp for ' + (c.name || 'this customer') + '.', 'success');
          });
      });
  }

  function shareBill(billId) {
    sendBillMessage(billId, 'bill');
  }

  function remindBill(billId) {
    sendBillMessage(billId, 'reminder');
  }

  /* Wiring --------------------------------------------------------------- */

  function wire() {
    var mobile = byId('billMobile');
    if (mobile) {
      // Searching on every keystroke would fire a query per letter and race the
      // replies, so a full mobile number goes the moment it is ten digits and
      // anything else waits for a pause in typing.
      var searchTimer = null;

      mobile.addEventListener('input', function () {
        var term = cleanTerm(mobile.value);
        if (searchTimer) window.clearTimeout(searchTimer);

        // Searching again for the customer already on screen would throw away
        // the ticks, so the same term is left alone - but only while there is a
        // customer on screen whose ticks are worth protecting.
        if (state.customer && term === state.term) return;

        if (isMobileTerm(term)) searchCustomer(term);
        else searchTimer = window.setTimeout(function () { searchCustomer(term); }, 300);
      });
    }

    each('[data-bill-pick]', function (b) {
      b.addEventListener('click', function () {
        var pick = state.matches.filter(function (m) {
          return m.id === b.getAttribute('data-bill-pick');
        })[0];

        if (pick) openCustomer(pick);
      });
    });

    each('[data-bill-order]', function (box) {
      box.addEventListener('change', function () {
        toggleOrder(box.getAttribute('data-bill-order'), box.checked);
      });
    });

    each('[data-bill-edit]', function (b) {
      b.addEventListener('click', function () {
        openEdit(b.getAttribute('data-bill-edit'));
      });
    });

    each('[data-bill-pay]', function (b) {
      b.addEventListener('click', function () {
        payNow(b.getAttribute('data-bill-pay'));
      });
    });

    each('[data-bill-print]', function (b) {
      b.addEventListener('click', function () {
        printBill(b.getAttribute('data-bill-print'));
      });
    });

    each('[data-bill-share]', function (b) {
      b.addEventListener('click', function () {
        shareBill(b.getAttribute('data-bill-share'));
      });
    });

    each('[data-bill-remind]', function (b) {
      b.addEventListener('click', function () {
        remindBill(b.getAttribute('data-bill-remind'));
      });
    });

    each('[data-bill-archive]', function (b) {
      b.addEventListener('click', function () {
        archive(b.getAttribute('data-bill-archive'));
      });
    });

    var notes = byId('billNotes');
    if (notes) {
      notes.addEventListener('input', function () { state.notes = notes.value; });
    }

    var save = byId('billSave');
    if (save) save.addEventListener('click', saveBill);

    var cancel = byId('billCancelEdit');
    if (cancel) cancel.addEventListener('click', closeEdit);

    var prev = byId('billPrev');
    if (prev) {
      prev.addEventListener('click', function () {
        if (state.page > 0) {
          state.page -= 1;
          loadBills();
        }
      });
    }

    var next = byId('billNext');
    if (next) {
      next.addEventListener('click', function () {
        state.page += 1;
        loadBills();
      });
    }
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  function render() {
    resetFor();
    paint();
    loadShop();
  }

  return {
    mount: mount,
    render: render,
    // Exposed so the harness can assert the wording of every part of the amount
    // in words. A wrong word there is read as a statement of fact by whoever signs
    // a crossed cheque against the line, so it is tested rather than trusted.
    __amountInWords: amountInWords,
    // The one-page fit, exposed for the same reason. It runs against a real
    // document in a real popup, so the harness drives it with one directly: the
    // arithmetic is checkable there, whereas a bill that came out as two pages is
    // only ever visible on paper.
    __fitToOnePage: fitToOnePage,
    __MIN_SCALE: MIN_SCALE
  };
})();

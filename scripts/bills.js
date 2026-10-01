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
 * PDF storage and WhatsApp delivery were Google Drive features in the legacy
 * system. bills.pdf_path is left for when a file store is decided on, and the
 * print view is built in the browser instead, so a bill prints with no server
 * round trip and no Drive account.
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
    // Shop details for the printed bill. Read once from shop_settings; a
    // missing or unreadable row simply means no UPI code is drawn.
    shop: { name: '', upiId: '', payee: '' }
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

  // The UPI id and payee name live in shop_settings, one row per key. They are
  // read here rather than copied onto the bill, so changing the id in Settings
  // changes the next bill printed with no re-save of anything. A missing row is
  // no UPI, and the bill prints without a code.
  function loadShop() {
    return sb().from('shop_settings')
      .select('key,value')
      .then(function (res) {
        var shop = { name: '', upiId: '', payee: '' };

        if (!res.error && res.data) {
          res.data.forEach(function (row) {
            if (row.key === 'shop_name') shop.name = row.value || '';
            else if (row.key === 'upi_id') shop.upiId = row.value || '';
            else if (row.key === 'upi_payee_name') shop.payee = row.value || '';
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

    if (!missing.length) {
      return Promise.resolve(ids.map(function (id) { return byId2[id]; }).filter(Boolean));
    }

    // An order on the bill may no longer be in the loaded list, for instance one
    // that was cancelled after the bill was raised. The bill still has to print.
    return sb().from('orders')
      .select('id,code,order_date,delivery_date,total,discount,advance')
      .in('id', missing)
      .then(function (res) {
        (res.data || []).forEach(function (o) { byId2[o.id] = o; });
        return ids.map(function (id) { return byId2[id]; }).filter(Boolean);
      });
  }

  function openPrintWindow(bill, list) {
    var c = state.customer;
    if (!c) {
      toast('Open a customer first, then print a bill.', 'error');
      return;
    }

    var rows = list.map(function (o) {
      return '<tr><td>' + esc(o.code) + '</td>' +
        '<td>' + esc(dateLabel(o.order_date)) + '</td>' +
        '<td>' + esc(dateLabel(o.delivery_date)) + '</td>' +
        '<td class="r">' + money(o.total) + '</td>' +
        '<td class="r">' + (num(o.discount) ? '- ' + money(o.discount) : money(0)) + '</td>' +
        '<td class="r">' + money(o.advance) + '</td></tr>';
    }).join('');

    // A UPI code is drawn only when a real amount is still owed and the shop
    // has a valid id configured. payLink() is the same builder the on-screen Pay
    // button uses, so a settled bill cannot print a code inviting the customer
    // to pay twice and the two can never name different accounts.
    var target = payLink(bill);
    var payBlock = '';

    if (target && window.ANT.qr) {
      var dueLabel = money(window.ANT.upi.balanceDue(bill));

      payBlock = '<div class="pay">' +
        window.ANT.qr.svg(target, {
          className: 'qr',
          border: 1,
          dark: '#000000',
          light: '#ffffff',
          label: 'Scan to pay ' + dueLabel + ' to ' + (state.shop.name || 'AN TAILOR')
        }) +
        '<div class="pay-text">' +
          '<div class="pay-head">Scan to pay ' + esc(dueLabel) + '</div>' +
          // Kept in the printed bill as well as on screen, because a bill sent
          // on as a PDF can still carry a link some viewers will open.
          '<a class="pay-link" href="' + esc(target) + '">Tap to Pay ' + esc(dueLabel) + '</a>' +
          '<div class="pay-id">UPI ID: ' + esc(state.shop.upiId) + '</div>' +
        '</div>' +
      '</div>';
    }

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' +
      esc(bill.code) + '</title><style>' +
      'body{font:14px/1.5 system-ui,"Segoe UI",Arial,sans-serif;color:#111;margin:24px}' +
      'h1{font-size:20px;margin:0 0 4px}' +
      '.sub{color:#555;margin:0 0 18px}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:18px}' +
      'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}' +
      'th{background:#f2f2f2;font-size:12px;text-transform:uppercase}' +
      '.r{text-align:right;white-space:nowrap}' +
      '.totals{margin-left:auto;width:300px}' +
      '.totals div{display:flex;justify-content:space-between;padding:4px 0}' +
      '.totals .due{font-weight:700;border-top:1px solid #111}' +
      '.pay{display:flex;gap:14px;align-items:center;border:1px solid #ccc;' +
        'border-radius:6px;padding:10px 12px;margin-top:18px;width:fit-content}' +
      '.qr{width:34mm;height:34mm;flex:0 0 auto}' +
      '.pay-text{font-size:13px}' +
      '.pay-head{font-weight:700;margin-bottom:2px}' +
      '.pay-link{display:inline-block;margin:2px 0;color:#0f2239;font-weight:600}' +
      '.pay-id{color:#555;margin-top:2px}' +
      'footer{margin-top:28px;font-size:12px;color:#555}' +
      // The link is left in the printed bill rather than hidden at print time.
      // Paper cannot be tapped, but the bill is very often sent on as a PDF, and
      // some viewers - WhatsApp among them - do make a link live there. Hiding it
      // would throw that away for the sake of a print preview nobody keeps.
      '@media print{body{margin:12mm}}' +
      '</style></head><body>' +
      '<h1>Bill ' + esc(bill.code) + '</h1>' +
      '<p class="sub">' + esc(c.name) + ' &middot; ' + esc(c.mobile) +
      (c.address ? ' &middot; ' + esc(c.address) : '') + '</p>' +
      '<table><thead><tr><th>Order</th><th>Order date</th><th>Delivery</th>' +
      '<th class="r">Total</th><th class="r">Discount</th><th class="r">Paid</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="totals">' +
      '<div><span>Total</span><span>' + money(bill.total) + '</span></div>' +
      '<div><span>Discount</span><span>- ' + money(bill.discount) + '</span></div>' +
      '<div><span>Bill amount</span><span>' + money(bill.bill_amount) + '</span></div>' +
      '<div><span>Paid</span><span>' + money(bill.advance) + '</span></div>' +
      '<div class="due"><span>Balance due</span><span>' +
        money(Math.max(0, num(bill.balance))) + '</span></div>' +
      '</div>' +
      (bill.method
        ? '<p class="sub">Paid by ' + esc(bill.method) +
          (bill.paid_on ? ' on ' + esc(dateLabel(bill.paid_on)) : '') + '</p>'
        : '') +
      (bill.notes ? '<p class="sub">' + esc(bill.notes) + '</p>' : '') +
      payBlock +
      '<footer>Printed ' + esc(dateLabel(today())) + ' from ' +
        esc(state.shop.name || 'AN TAILOR') + '.</footer>' +
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

  /* Taking a payment ------------------------------------------------------- */

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

  return { mount: mount, render: render };
})();

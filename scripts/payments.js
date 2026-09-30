/* AN TAILOR - Payments.
 *
 * A payment is money received against exactly one order. The legacy system had
 * no customer-level payment and no way to settle several orders at once, and
 * that is kept: a balance belongs to an order, so a payment belongs to an
 * order too.
 *
 * The rules are copied from the legacy Payment.gs:
 *
 *   new_advance = old_advance + amount
 *   new_balance = old_balance - amount
 *
 * The balance is subtracted from the stored balance rather than recomputed from
 * total - discount - advance, exactly as the legacy code did. Recomputing would
 * be tidier but would silently change an order whose numbers have drifted, and
 * drift is the thing the legacy advancePaymentRepair existed to fix, not to
 * paper over on every keystroke.
 *
 * previous_balance and new_balance are stored on the payment as a snapshot of
 * the order at the moment it was taken. That is what the legacy sheet recorded
 * and it is what makes an audit trail possible after the fact.
 *
 * Two guard rails protect the money:
 *
 *   - A payment may not exceed the order's outstanding balance. The legacy
 *     server refused this, and refusing is the right call: a tailor who takes
 *     5000 against a 400 balance has not been paid, and recording it as a
 *     payment hides that.
 *   - The payment row and the order's advance/balance are written together. If
 *     either half fails the other is undone, so the two can never disagree
 *     silently.
 *
 * Payments are append only. There is no edit and no delete, which is also the
 * legacy behaviour: the order's advance is the authority on what is owed, and
 * deleting a payment would desynchronise the two with nothing left to repair it.
 */

window.ANT = window.ANT || {};

window.ANT.payments = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };
  var money = function (v) { return window.ANT.money(v); };

  // Taken verbatim from the legacy Payments.html. Renaming these would break the
  // collection report's mode buckets, which match on the stored string.
  var METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

  var PAGE_SIZE = 25;

  var state = {
    view: 'list',
    orders: [],
    items: {},
    orderFilter: '',
    payments: [],
    search: '',
    page: 0,
    count: 0,
    selected: null,
    customer: null,
    amount: '',
    method: 'Cash',
    notes: '',
    error: null,
    busy: false,
    saved: false
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
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function isOwner() {
    var u = window.ANT.auth && window.ANT.auth.currentUser && window.ANT.auth.currentUser();
    return !!u && u.role === 'owner';
  }

  // The balance a payment may not exceed. Orders that still owe are the only
  // ones offered, so this is always positive, but it is clamped anyway so a
  // stale row can never produce a negative figure on screen.
  function owed(order) {
    return Math.max(0, round2(num(order.balance)));
  }

  /* Loading ------------------------------------------------------------- */

  // Only orders that can actually take a payment: a positive balance, and not
  // cancelled. The legacy pending-balances report excluded Cancelled for the
  // same reason, and it is kept here so the two lists agree.
  function loadOrders() {
    state.loading = true;
    paint();

    var q = sb().from('orders')
      .select('id,code,customer_id,order_date,status,total,discount,advance,balance, customer:customers(id,code,name,mobile)')
      .gt('balance', 0)
      .neq('status', 'Cancelled')
      .order('balance', false)
      .order('order_date', true);

    if (state.orderFilter) q = q.eq('customer_id', state.orderFilter);

    return q.then(function (res) {
      state.loading = false;
      if (res.error) {
        state.error = 'Could not load the orders that still owe: ' +
          (res.error.message || 'the request was rejected.');
        state.orders = [];
      } else {
        state.error = null;
        state.orders = res.data || [];
      }
      paint();
    });
  }

  function loadPayments() {
    var from = state.page * PAGE_SIZE;

    var q = sb().from('payments')
      .select('id,code,order_id,customer_id,amount,method,reference,previous_balance,new_balance,notes,paid_on,created_at, customer:customers(id,code,name,mobile)', { count: true })
      .order('paid_on', false)
      .order('created_at', false)
      .range(from, from + PAGE_SIZE - 1);

    return q.then(function (res) {
      if (res.error) {
        toast('Payment history could not be loaded: ' +
          (res.error.message || 'the request was rejected.'), 'error');
        state.payments = [];
        state.count = 0;
        return;
      }
      state.payments = res.data || [];
      state.count = res.count == null ? state.payments.length : res.count;
    });
  }

  // payments.code is NOT NULL with no default, so the number has to exist before
  // the insert. It cannot be generated afterwards.
  function nextCode() {
    return sb().from('payments')
      .select('code')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        var n = 1;
        if (res && !res.error && res.data && res.data.length) {
          var m = /(\d+)\s*$/.exec(res.data[0].code || '');
          if (m) n = parseInt(m[1], 10) + 1;
        }
        return 'PAY-' + String(n).padStart(4, '0');
      });
  }

  /* View ---------------------------------------------------------------- */

  function mount() {
    return '<div id="paymentsView"></div>';
  }

  function paint() {
    var host = byId('paymentsView');
    if (!host) return;
    host.innerHTML = state.view === 'record' ? recordPage() : listPage();
    wire();
  }

  function listPage() {
    return pageHead() +
      (state.error ? errorCard(state.error) : '') +
      payableCard() +
      historyCard() +
      pager();
  }

  function pageHead() {
    var owing = state.orders.reduce(function (s, o) { return s + owed(o); }, 0);
    return '<div class="page-head"><div>' +
      '<h1 class="page-head-title">Payments</h1>' +
      '<p class="page-head-sub">Take money against an order that still owes. ' +
      'A payment is recorded once and cannot be edited afterwards.</p>' +
      '</div><div class="page-head-actions">' +
      '<div class="ord-kpi"><span>Outstanding</span><strong>' + money(owing) + '</strong></div>' +
      '</div></div>';
  }

  function errorCard(message) {
    return '<div class="ui-card ord-err">' +
      '<h2 class="ui-card-title">Could not load payments</h2>' +
      '<p class="ui-card-sub">' + esc(message) + '</p>' +
      '</div>';
  }

  // ---------- orders that still owe ----------

  function payableCard() {
    var body;
    if (state.loading) {
      body = '<div class="empty"><p class="empty-text">Loading…</p></div>';
    } else if (!state.orders.length) {
      body = '<div class="empty"><div class="empty-title">Nothing outstanding</div>' +
        '<p class="empty-text">Every order is either settled or cancelled.</p></div>';
    } else {
      body = '<table class="ui-table"><thead><tr>' +
        '<th>Order</th><th>Customer</th><th>Order date</th>' +
        '<th class="num">Total</th><th class="num">Discount</th>' +
        '<th class="num">Paid</th><th class="num">Balance</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        state.orders.map(payableRow).join('') +
        '</tbody></table>';
    }

    return '<div class="ui-card"><h2 class="ui-card-title">Orders that still owe</h2>' +
      '<p class="ui-card-sub">A payment is always against one order. Choose an order to take money.</p>' +
      body + '</div>';
  }

  function payableRow(o) {
    return '<tr>' +
      '<td><span class="ord-mono">' + esc(o.code) + '</span></td>' +
      '<td>' + esc(o.customer ? o.customer.name : '—') +
        (o.customer && o.customer.mobile ? '<div class="ord-sub">' + esc(o.customer.mobile) + '</div>' : '') +
      '</td>' +
      '<td>' + esc(dateLabel(o.order_date)) + '</td>' +
      '<td class="num">' + money(o.total) + '</td>' +
      '<td class="num">' + money(o.discount) + '</td>' +
      '<td class="num">' + money(o.advance) + '</td>' +
      '<td class="num"><strong>' + money(owed(o)) + '</strong></td>' +
      '<td>' + chip(o.status) + '</td>' +
      '<td class="ord-row-actions"><button class="btn btn-sm btn-primary" data-pay-order="' + esc(o.id) + '">' +
        'Take payment</button></td>' +
      '</tr>';
  }

  function chip(status) {
    var s = status || 'Pending';
    var kind = {
      'Pending': 'chip-warn',
      'In Progress': 'chip-info',
      'Ready': 'chip-info',
      'Delivered': 'chip-success',
      'Cancelled': 'chip-muted'
    }[s] || 'chip-muted';
    return '<span class="chip ' + kind + '">' + esc(s) + '</span>';
  }

  // ---------- payment history ----------

  function historyCard() {
    var body;
    if (!state.payments.length) {
      body = '<div class="empty"><p class="empty-text">No payments recorded yet.</p></div>';
    } else {
      body = '<table class="ui-table"><thead><tr>' +
        '<th>Payment</th><th>Order</th><th>Customer</th><th>Date</th>' +
        '<th>Method</th><th class="num">Amount</th>' +
        '<th class="num">Balance before</th><th class="num">Balance after</th>' +
        '<th>Notes</th>' +
        '</tr></thead><tbody>' +
        state.payments.map(historyRow).join('') +
        '</tbody></table>';
    }

    return '<div class="ui-card"><h2 class="ui-card-title">Payment history</h2>' +
      '<p class="ui-card-sub">Append only. A payment is never edited or deleted, so the ' +
      'balance before and after each one is the audit trail.</p>' +
      body + '</div>';
  }

  function historyRow(p) {
    return '<tr>' +
      '<td><span class="ord-mono">' + esc(p.code) + '</span>' +
        (p.reference ? '<div class="ord-sub">' + esc(p.reference) + '</div>' : '') + '</td>' +
      '<td><span class="ord-link" data-pay-order="' + esc(p.order_id) + '">' +
        esc(orderCodeOf(p.order_id)) + '</span></td>' +
      '<td>' + esc(p.customer ? p.customer.name : '—') + '</td>' +
      '<td>' + esc(dateLabel(p.paid_on || p.created_at)) + '</td>' +
      '<td>' + esc(p.method) + '</td>' +
      '<td class="num"><strong>' + money(p.amount) + '</strong></td>' +
      '<td class="num">' + money(p.previous_balance) + '</td>' +
      '<td class="num">' + money(p.new_balance) + '</td>' +
      '<td class="ord-note">' + esc(p.notes || '') + '</td>' +
      '</tr>';
  }

  // The history list only carries payment rows, not the orders they point at, so
  // a short code is looked up from the payable list when it is to hand. When it
  // is not - a settled order - the short id is shown instead of a blank cell.
  function orderCodeOf(orderId) {
    if (!orderId) return '—';
    var hit = state.orders.filter(function (o) { return o.id === orderId; })[0];
    return hit ? hit.code : orderId.slice(0, 8);
  }

  function pager() {
    var pages = Math.max(1, Math.ceil(state.count / PAGE_SIZE));
    if (pages <= 1) return '';
    return '<div class="cust-pager">' +
      '<button class="btn btn-sm btn-secondary" id="payPrev"' + (state.page === 0 ? ' disabled' : '') + '>Previous</button>' +
      '<span class="cust-count">Page ' + (state.page + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="payNext"' + (state.page + 1 >= pages ? ' disabled' : '') + '>Next</button>' +
      '</div>';
  }

  // ---------- taking a payment ----------

  function recordPage() {
    var o = state.selected;
    var balance = owed(o);
    var amount = numField(state.amount);
    var after = round2(balance - amount);

    return '<div class="page-head"><div>' +
      '<h1 class="page-head-title">Take a payment</h1>' +
      '<p class="page-head-sub">Against order ' + esc(o.code) + ' for ' + esc(o.customer ? o.customer.name : '—') + '.</p>' +
      '</div><div class="page-head-actions">' +
      '<button class="btn btn-secondary" id="payCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="paySave"' + (state.busy ? ' disabled' : '') + '>' +
        (state.busy ? 'Recording…' : 'Record payment') + '</button>' +
      '</div></div>' +

      '<div class="ui-card"><div class="pay-grid">' +
        '<div class="ui-field"><label class="ui-label">Order</label>' +
          '<input class="ui-input ord-fixed" value="' + esc(o.code) + '" readonly></div>' +
        '<div class="ui-field"><label class="ui-label">Order balance</label>' +
          '<input class="ui-input ord-fixed" value="' + money(balance) + '" readonly></div>' +
        '<div class="ui-field"><label class="ui-label">Payment amount</label>' +
          '<input class="ui-input" id="payAmount" inputmode="decimal" value="' + esc(state.amount) + '"></div>' +
        '<div class="ui-field"><label class="ui-label">Method</label>' +
          '<select class="ui-input" id="payMethod">' +
            METHODS.map(function (mth) {
              return '<option value="' + esc(mth) + '"' + (mth === state.method ? ' selected' : '') + '>' + esc(mth) + '</option>';
            }).join('') +
          '</select></div>' +
        '<div class="ui-field"><label class="ui-label">Reference</label>' +
          '<input class="ui-input" id="payReference" value="' + esc(state.reference || '') + '" placeholder="UPI or cheque number (optional)"></div>' +
        '<div class="ui-field"><label class="ui-label">Paid on</label>' +
          '<input class="ui-input" id="payDate" type="date" value="' + esc(state.paidOn || today()) + '"></div>' +
        '<div class="ui-field"><label class="ui-label">Balance after this payment</label>' +
          '<input class="ui-input ord-fixed" id="payAfter" value="' + money(after) + '" readonly></div>' +
      '</div>' +
      '<div class="ui-field ui-field-wide"><label class="ui-label">Notes</label>' +
        '<textarea class="ui-input" id="payNotes" placeholder="Enter any notes (optional)">' + esc(state.notes) + '</textarea></div>' +
      '<div class="pay-hint" id="payHint">' + hintFor(amount, balance) + '</div>' +
      '</div>';
  }

  // The remaining balance updates as the amount is typed, so an overpayment is
  // visible before the save rather than after it is refused. The amount arrives
  // as the raw field text, so it is coerced here: comparing the string '1300'
  // with the number 1300 makes every settled order read as "leaves 0".
  function hintFor(value, balance) {
    var amount = num(value);
    if (!amount) return 'Enter how much is being paid.';
    if (amount > balance) {
      return 'This is more than the ' + money(balance) + ' outstanding. It will be refused.';
    }
    if (amount === round2(balance)) return 'This settles the order in full.';
    return 'Leaves ' + money(round2(balance - amount)) + ' outstanding.';
  }

  function numField(value) {
    var s = String(value == null ? '' : value).replace(/[^0-9.]/g, '');
    var parts = s.split('.');
    if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
    if (s === '.') s = '0.';
    return s;
  }

  /* Actions ------------------------------------------------------------- */

  function openRecord(id) {
    var o = state.orders.filter(function (x) { return x.id === id; })[0];
    if (!o) {
      toast('That order is no longer outstanding.', 'error');
      return;
    }

    var balance = owed(o);
    if (balance <= 0) {
      toast('That order has nothing outstanding to pay.', 'error');
      return;
    }

    state.selected = o;
    state.customer = o.customer || null;
    // The full balance is offered first, because paying it off in one go is the
    // common case, but it stays editable so a part payment is one keystroke away.
    state.amount = String(balance);
    state.method = 'Cash';
    state.notes = '';
    state.reference = '';
    state.paidOn = today();
    state.busy = false;
    state.saved = false;
    state.view = 'record';
    paint();

    var box = byId('payAmount');
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  function closeRecord() {
    state.view = 'list';
    state.selected = null;
    state.customer = null;
    state.busy = false;
    paint();
  }

  function validate() {
    var o = state.selected;
    if (!o) return 'Choose an order first.';

    var amount = num(numField(state.amount));
    if (!amount || amount <= 0) return 'Enter a valid payment amount.';

    var balance = owed(o);
    if (amount > balance) return 'Payment amount is more than the balance.';
    return '';
  }

  function record() {
    var problem = validate();
    if (problem) {
      toast(problem, 'error');
      return;
    }

    var o = state.selected;
    var amount = round2(num(numField(state.amount)));
    var oldAdvance = num(o.advance);
    var oldBalance = owed(o);
    var newAdvance = round2(oldAdvance + amount);
    var newBalance = round2(oldBalance - amount);
    var before = state.orders;
    var payCode = '';

    state.busy = true;
    paint();

    nextCode().then(function (code) {
      payCode = code;
      return sb().from('payments')
        .insert({
          code: code,
          order_id: o.id,
          customer_id: o.customer_id,
          amount: amount,
          method: state.method,
          reference: state.reference || '',
          previous_balance: oldBalance,
          new_balance: newBalance,
          notes: state.notes || '',
          paid_on: state.paidOn || today()
        })
        .single()
        .then(function (res) {
          if (res.error) {
            // A sentinel rather than a bare return, so the success path below
            // cannot run and report a payment that was never stored.
            return { notStored: true, message: res.error.message || 'the payment row was rejected.' };
          }
          return updateOrder(o, newAdvance, newBalance);
        });
    }).then(function (res) {
      if (res && res.notStored) {
        state.busy = false;
        paint();
        toast('The payment was not recorded: ' + res.message, 'error');
        return;
      }

      if (res && res.error) {
        // The order is the authority on what is owed, so a payment row without a
        // matching order update is worse than no payment at all. The row is
        // removed again rather than left to drift.
        return sb().from('payments')
          .remove()
          .eq('code', payCode)
          .then(function () {
            state.busy = false;
            paint();
            toast('The order could not be updated, so the payment was rolled back: ' +
              res.error.message, 'error');
          });
      }

      state.busy = false;
      // Optimistically settle the row in place, then reload the truth.
      before.forEach(function (x) {
        if (x.id === o.id) {
          x.advance = newAdvance;
          x.balance = newBalance;
        }
      });
      state.view = 'list';
      state.selected = null;
      state.page = 0;
      toast('Payment of ' + money(amount) + ' recorded.', 'success');
      return loadPayments().then(function () { return loadOrders(); });
    });
  }

  // The order row is updated in the same breath as the payment, because the
  // balance on the order is what the list and the next payment both read.
  function updateOrder(o, newAdvance, newBalance) {
    return sb().from('orders')
      .update({ advance: newAdvance, balance: newBalance })
      .eq('id', o.id)
      .select('id')
      .then(function (res) {
        if (res.error) {
          return {
            error: {
              message: res.error.message || 'the order row was rejected.'
            }
          };
        }
        // A row that vanished - deleted by another user mid-payment - answers
        // with no rows rather than an error, so it is checked explicitly.
        if (!res.data || !res.data.length) {
          return { error: { message: 'The order no longer exists.' } };
        }
        return null;
      });
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pay-order]'), function (btn) {
      btn.addEventListener('click', function () {
        openRecord(btn.getAttribute('data-pay-order'));
      });
    });

    var cancel = byId('payCancel');
    if (cancel) cancel.addEventListener('click', closeRecord);

    var save = byId('paySave');
    if (save) {
      save.addEventListener('click', record);
      // Ctrl+Enter saves, which matters on a phone keyboard where the button may
      // be scrolled off screen.
      save.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); record(); }
      });
    }

    var amount = byId('payAmount');
    if (amount) {
      amount.addEventListener('input', function () {
        var clean = numField(amount.value);
        state.amount = clean;
        // What is typed is tidied to the number that will actually be saved - a
        // leading minus or a second dot is dropped - because a field reading
        // "-50" above a payment of 50 is worse than a stray keystroke. The caret
        // is put back where it was, or the field would fight the typist.
        if (clean !== amount.value) {
          var at = amount.selectionStart;
          amount.value = clean;
          if (at != null) {
            var spot = Math.min(at, clean.length);
            amount.setSelectionRange(spot, spot);
          }
        }
        // Only the two dependent cells are rewritten, so the caret stays put.
        var after = byId('payAfter');
        if (after) after.value = money(round2(owed(state.selected) - num(state.amount)));
        var hint = byId('payHint');
        if (hint) hint.textContent = hintFor(state.amount, owed(state.selected));
      });
    }

    var method = byId('payMethod');
    if (method) method.addEventListener('change', function () { state.method = method.value; });

    var notes = byId('payNotes');
    if (notes) notes.addEventListener('input', function () { state.notes = notes.value; });

    var ref = byId('payReference');
    if (ref) ref.addEventListener('input', function () { state.reference = ref.value; });

    var date = byId('payDate');
    if (date) date.addEventListener('change', function () { state.paidOn = date.value; });

    var prev = byId('payPrev');
    if (prev) prev.addEventListener('click', function () {
      if (state.page === 0) return;
      state.page -= 1;
      loadPayments().then(paint);
    });

    var next = byId('payNext');
    if (next) next.addEventListener('click', function () {
      state.page += 1;
      loadPayments().then(paint);
    });
  }

  function render() {
    state.view = 'list';
    state.orders = [];
    state.payments = [];
    state.page = 0;
    state.count = 0;
    state.error = null;
    state.selected = null;
    state.customer = null;
    state.loading = true;
    paint();
    loadPayments().then(function () { return loadOrders(); });
  }

  return { mount: mount, render: render };
})();

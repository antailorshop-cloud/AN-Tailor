/* AN TAILOR - Orders.
 *
 * An order is a parent row plus its items. The parent carries the money summary
 * so the list can be rendered without loading every item, and so a dashboard
 * query never has to aggregate a child table.
 *
 * The money rules are copied from the legacy Order.gs exactly, because changing
 * them would silently change what the shop owes:
 *
 *   line_total = quantity * rate + extra_charge      (per item)
 *   total      = sum of line_total                    (per order)
 *   balance    = total - discount - advance
 *
 * A discount belongs to the whole order, not to a line, and the legacy code
 * forced the per-line discount to zero. The parent row therefore owns it and
 * order_items.discount stays 0 until a per-line discount is actually wanted.
 * A discount larger than the total is rejected rather than producing a
 * negative balance.
 *
 * Every item needs its own delivery date. That is the point of the item table:
 * a shirt due Friday and a pair of trousers due next Tuesday are one order with
 * two promises, and the parent delivery_date is simply the latest of them.
 *
 * The advance is intentionally not editable here. Changing it would move the
 * balance without a matching row in payments, which is exactly the drift the
 * legacy advancePaymentRepair function existed to clean up. Payments adjusts the
 * advance, and this form only shows it.
 */

window.ANT = window.ANT || {};

window.ANT.orders = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };
  var money = function (v) { return window.ANT.money(v); };

  var STATUSES = ['Pending', 'In Progress', 'Ready', 'Delivered', 'Cancelled'];
  var PRIORITIES = ['Normal', 'Urgent'];
  var SERVICES = ['Tailoring', 'Resale'];
  var PAGE_SIZE = 25;
  var MAX_ITEMS = 50;

  var state = {
    view: 'list',        // 'list' or 'edit'
    search: '',
    searchNote: '',
    status: '',
    page: 0,
    count: 0,
    orders: [],
    items: {},           // order_id -> items[]
    loading: false,
    error: null,

    // form
    form: null,          // null | 'new' | order row
    formItems: [],
    formCustomer: null,
    customers: [],
    customerQuery: '',
    dressTypes: [],
    prices: [],
    measurements: [],
    saving: false,
    saveError: ''
  };

  var custTimer = null;
  var saveTimer = null;

  function me() {
    return window.ANT.auth.current() || {};
  }

  function isOwner() {
    return me().role === 'owner';
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /* Helpers ------------------------------------------------------------ */

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function dateLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function overdue(iso) {
    if (!iso) return false;
    return String(iso) < today();
  }

  function statusChip(status) {
    var kind = {
      'Pending': 'chip-warn',
      'In Progress': 'chip-info',
      'Ready': 'chip-info',
      'Delivered': 'chip-success',
      'Cancelled': 'chip-muted'
    }[status] || 'chip-muted';
    return '<span class="chip ' + kind + '">' + esc(status) + '</span>';
  }

  // Sorted once, then reused for every item row. The Settings module edits
  // dress_types, so the list is read from the database rather than hardcoded
  // here the way the measurement field lists are.
  function groupedDressTypes() {
    var groups = { Gents: [], Ladies: [], Other: [] };
    state.dressTypes.forEach(function (d) {
      var name = d.dress_type;
      if (groups[d.category]) groups[d.category].push(name);
      else groups.Other.push(name);
    });
    return groups;
  }

  function lineTotal(item) {
    return round2(num(item.qty) * num(item.rate) + num(item.extra));
  }

  function totalsOf(items, discount, advance) {
    var total = 0;
    items.forEach(function (i) { total += lineTotal(i); });
    total = round2(total);
    var d = num(discount);
    var a = num(advance);
    return {
      total: total,
      discount: d,
      advance: a,
      balance: round2(total - d - a)
    };
  }

  function latestDelivery(items) {
    var latest = '';
    items.forEach(function (i) {
      var v = i.delivery_date || '';
      if (v && v > latest) latest = v;
    });
    return latest;
  }

  /* Reference data ------------------------------------------------------ */

  function loadReference() {
    if (state.dressTypes.length) return Promise.resolve();
    return sb().from('dress_types')
      .select('id,category,dress_type')
      .order('category', true)
      .order('dress_type', true)
      .then(function (res) {
        if (res.error) {
          toast(res.error.message, 'error');
          return;
        }
        state.dressTypes = res.data || [];
      });
  }

  // Prices are only offered as suggestions on the rate box. They are not applied
  // automatically, because the rate agreed with the customer is what matters,
  // not the list price.
  function loadPrices() {
    if (state.prices.length) return Promise.resolve();
    return sb().from('prices')
      .select('item,option,amount,group_name')
      .eq('status', 'Active')
      .then(function (res) {
        if (res.error) return;
        state.prices = res.data || [];
      });
  }

  function loadMeasurements(customerId) {
    if (!customerId) {
      state.measurements = [];
      return Promise.resolve();
    }
    return sb().from('measurements')
      .select('id,code,dress_type,created_at')
      .eq('customer_id', customerId)
      .order('created_at', false)
      .then(function (res) {
        state.measurements = (res && !res.error && res.data) || [];
      });
  }

  /* List ---------------------------------------------------------------- */

  function loadOrders() {
    state.loading = true;
    paint();

    var from = state.page * PAGE_SIZE;
    var q = sb().from('orders').select('*, customer:customers(id,code,name,mobile)', { count: true });

    if (state.status) q = q.eq('status', state.status);

    if (state.search) q = q.or(searchFilter(state.search));

    q = q.order('order_date', false)
      .order('created_at', false)
      .range(from, from + PAGE_SIZE - 1);

    return q.then(function (res) {
      // The customer name lives in another table, so the search needs a join.
      // If this PostgREST build refuses the embedded filter, fall back to
      // matching the order's own columns rather than leaving the page broken.
      if (res.error && state.search) return loadOrdersWithoutJoin(from);
      return finishOrders(res);
    });
  }

  // Wrapped in one or=(...) group by the client's own parentheses handling, so
  // the join cannot leak out and turn into a filter on the customers table.
  function searchFilter(term) {
    var clean = '*' + String(term).replace(/[*%,()]/g, ' ') + '*';
    return 'code.ilike.' + clean +
      ',notes.ilike.' + clean +
      ',customer:customers!inner(name.ilike.' + clean + ',mobile.ilike.' + clean + ')';
  }

  function loadOrdersWithoutJoin(from) {
    var q = sb().from('orders').select('*', { count: true });
    if (state.status) q = q.eq('status', state.status);

    var clean = '*' + state.search.replace(/[*%,()]/g, ' ') + '*';
    q = q.or('code.ilike.' + clean + ',notes.ilike.' + clean)
      .order('order_date', false)
      .order('created_at', false)
      .range(from, from + PAGE_SIZE - 1);

    return q.then(function (res) {
      if (res.error) return finishOrders(res);
      if (state.search) {
        state.searchNote = 'Searching order numbers only. Customer name search is unavailable on this connection.';
      }
      return finishOrders(res);
    });
  }

  function finishOrders(res) {
    state.loading = false;
    if (res.error) {
      state.error = res.error.message;
      state.orders = [];
      paint();
      return null;
    }
    state.error = null;
    state.orders = res.data || [];
    state.count = res.count != null ? res.count : state.orders.length;
    return loadItemsFor(state.orders).then(paint);
  }

  // One query for every visible order, not one per row.
  function loadItemsFor(orders) {
    var ids = orders.map(function (o) { return o.id; });
    if (!ids.length) {
      state.items = {};
      return Promise.resolve();
    }
    return sb().from('order_items')
      .select('*')
      .in('order_id', ids)
      .is('archived_at', null)
      .order('line_no', true)
      .then(function (res) {
        var map = {};
        if (res.error) {
          state.items = map;
          return;
        }
        (res.data || []).forEach(function (it) {
          if (!map[it.order_id]) map[it.order_id] = [];
          map[it.order_id].push(it);
        });
        state.items = map;
      });
  }

  function summarise(order) {
    var items = state.items[order.id] || [];
    if (!items.length) return '—';
    var dress = items.map(function (i) { return i.dress_type; }).filter(Boolean);
    var head = dress.length ? dress[0] : 'Item';
    var rest = dress.length - 1;
    return esc(head) + (rest > 0 ? ' <span class="ord-more">+' + rest + '</span>' : '');
  }

  /* View ---------------------------------------------------------------- */

  function paint() {
    var host = byId('ordersView');
    if (!host) return;
    host.innerHTML = state.view === 'edit' ? editPage() : listPage();
    wire();
  }

  function listPage() {
    return pageHead() + toolbar() +
      (state.searchNote ? '<p class="ui-hint ord-note">' + esc(state.searchNote) + '</p>' : '') +
      (state.error ? errorCard('Could not load orders', state.error, '') : '') + tableCard() + pager();
  }

  function pageHead() {
    var open = state.orders.filter(function (o) {
      return o.status !== 'Delivered' && o.status !== 'Cancelled';
    }).length;

    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">Orders</h1>' +
        '<p class="page-head-sub">One order can hold many items, and each item carries its own delivery date.</p>' +
      '</div>' +
      '<div class="page-head-actions">' +
        '<button class="btn btn-primary" id="ordNew">+ New order</button>' +
      '</div>' +
    '</div>' +
    '<div class="ord-stats">' +
      '<div class="stat"><span class="stat-label">Showing</span><span class="stat-value">' + state.orders.length + '</span></div>' +
      '<div class="stat"><span class="stat-label">Still open</span><span class="stat-value">' + open + '</span></div>' +
      '<div class="stat"><span class="stat-label">Order value</span><span class="stat-value">' +
        money(state.orders.reduce(function (a, o) { return a + num(o.total); }, 0)) +
      '</span></div>' +
      '<div class="stat"><span class="stat-label">Outstanding</span><span class="stat-value">' +
        money(state.orders.reduce(function (a, o) { return a + num(o.balance); }, 0)) +
      '</span></div>' +
    '</div>';
  }

  function toolbar() {
    return '<div class="ui-card cust-toolbar">' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordSearch">Search</label>' +
        '<input class="ui-input" id="ordSearch" type="search" placeholder="Order number, customer or mobile" ' +
          'value="' + esc(state.search) + '" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordStatus">Status</label>' +
        '<select class="ui-input" id="ordStatus">' +
          '<option value="">All</option>' +
          STATUSES.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === state.status ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
    '</div>';
  }

  function errorCard(title, detail, hint) {
    return '<div class="ui-card ord-err">' +
      '<h2 class="ui-card-title">' + esc(title) + '</h2>' +
      '<p class="ui-card-sub">' + esc(detail) + '</p>' +
      (hint ? '<p class="ui-hint">' + esc(hint) + '</p>' : '') +
    '</div>';
  }

  function tableCard() {
    if (state.loading && !state.orders.length) {
      return '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    if (!state.orders.length) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">No orders found</div>' +
        '<p class="empty-text">' +
          (state.search || state.status
            ? 'Nothing matches this search. Clear the filters to see everything.'
            : 'Create the first order using the button above.') +
        '</p>' +
      '</div></div>';
    }

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Order list</h2>' +
      '<p class="ui-card-sub">Newest first. Balance is what the customer still owes.</p>' +
      '<div class="table-wrap">' +
        '<table class="ui-table">' +
          '<thead><tr>' +
            '<th>Order</th><th>Customer</th><th>Items</th><th>Delivery</th>' +
            '<th class="num">Total</th><th class="num">Balance</th><th>Status</th><th></th>' +
          '</tr></thead>' +
          '<tbody>' + state.orders.map(row).join('') + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  }

  function row(o) {
    var items = state.items[o.id] || [];
    var count = items.length || o.item_count || 0;
    var late = overdue(o.delivery_date) && o.status !== 'Delivered' && o.status !== 'Cancelled';

    return '<tr>' +
      '<td><button class="ord-link" data-ord-open="' + esc(o.id) + '">' + esc(o.code) + '</button>' +
        (o.priority === 'Urgent' ? ' <span class="chip chip-warn">Urgent</span>' : '') +
        '<div class="ord-sub">' + esc(dateLabel(o.order_date)) + '</div>' +
      '</td>' +
      '<td>' + esc(customerName(o)) +
        (o.customer && o.customer.mobile ? '<div class="ord-sub">' + esc(o.customer.mobile) + '</div>' : '') +
      '</td>' +
      '<td>' + summarise(o) + '<div class="ord-sub">' + count + (count === 1 ? ' item' : ' items') + '</div></td>' +
      '<td>' + (late ? '<span class="ord-late">' : '<span>') + esc(dateLabel(o.delivery_date)) + '</span>' +
        '<div class="ord-sub">' + esc(items.filter(function (i) { return overdue(i.delivery_date); }).length ? 'partly late' : '') + '</div></td>' +
      '<td class="num">' + money(o.total) + '</td>' +
      '<td class="num">' + (num(o.balance) > 0 ? '<strong>' + money(o.balance) + '</strong>' : money(o.balance)) + '</td>' +
      '<td>' + statusChip(o.status) + '</td>' +
      '<td class="ord-row-actions">' +
        '<button class="btn btn-sm btn-secondary" data-ord-open="' + esc(o.id) + '">Open</button>' +
      '</td>' +
    '</tr>';
  }

  function customerName(o) {
    if (o.customer && o.customer.name) return o.customer.name;
    if (o.customer_name) return o.customer_name;
    return '—';
  }

  function pager() {
    var pages = Math.max(1, Math.ceil(state.count / PAGE_SIZE));
    if (pages <= 1) return '';
    return '<div class="cust-pager">' +
      '<button class="btn btn-sm btn-secondary" id="ordPrev"' + (state.page === 0 ? ' disabled' : '') + '>Previous</button>' +
      '<span class="cust-count">Page ' + (state.page + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="ordNext"' + (state.page + 1 >= pages ? ' disabled' : '') + '>Next</button>' +
    '</div>';
  }

  /* Edit ---------------------------------------------------------------- */

  function editPage() {
    var editing = state.form !== 'new';
    var order = editing ? state.form : null;
    var t = totalsOf(state.formItems, order ? order.discount : 0, order ? order.advance : 0);

    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">' + (editing ? 'Order ' + esc(order.code) : 'New order') + '</h1>' +
        '<p class="page-head-sub">' + (editing
          ? 'Changes are saved straight away when you press Save order.'
          : 'Add the customer, then one row per garment. Every row needs its own delivery date.') + '</p>' +
      '</div>' +
      '<div class="page-head-actions">' +
        '<button class="btn btn-secondary" id="ordBack">Back to list</button>' +
      '</div>' +
    '</div>' +
    (state.saveError
      ? errorCard('The order was not saved', state.saveError,
          'Everything you typed is still on screen. Fix the problem above and press Save order again.')
      : '') +
    (editing ? statusBar(order) : '') +
    customerCard(editing) +
    itemsCard() +
    totalsCard(order, t) +
    saveBar(editing);
  }

  function statusBar(order) {
    return '<div class="ui-card ord-status-bar">' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordStatusEdit">Status</label>' +
        '<select class="ui-input" id="ordStatusEdit">' +
          STATUSES.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === order.status ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordPriorityEdit">Priority</label>' +
        '<select class="ui-input" id="ordPriorityEdit">' +
          PRIORITIES.map(function (p) {
            return '<option value="' + esc(p) + '"' + (p === order.priority ? ' selected' : '') + '>' + esc(p) + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      (isOwner()
        ? '<div class="ord-danger">' +
            '<button class="btn btn-sm btn-danger" id="ordDelete">Delete order</button>' +
            '<span class="ui-hint">Removes the order and its items for good.</span>' +
          '</div>'
        : '') +
    '</div>';
  }

  function customerCard(editing) {
    if (editing) {
      return '<div class="ui-card">' +
        '<h2 class="ui-card-title">Customer</h2>' +
        '<div class="msr-cust">' +
          '<div>' +
            '<div class="msr-cust-name">' + esc(customerName(state.form)) + '</div>' +
            '<div class="msr-cust-meta">' +
              esc(state.form.customer ? state.form.customer.code : '') +
              (state.form.customer && state.form.customer.mobile ? ' · ' + esc(state.form.customer.mobile) : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    var results = '';
    if (state.customers.length) {
      results = '<div class="msr-results" id="ordCustResults">' +
        state.customers.map(function (c) {
          return '<button class="msr-result" data-ord-cust="' + esc(c.id) + '">' +
            '<span class="msr-result-name">' + esc(c.name) + '</span>' +
            '<span class="msr-result-meta">' + esc(c.code) + (c.mobile ? ' · ' + esc(c.mobile) : '') + '</span>' +
          '</button>';
        }).join('') +
      '</div>';
    }

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Customer</h2>' +
      '<p class="ui-card-sub">An order always belongs to a customer, so the same person keeps all their orders together.</p>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordCustSearch">Search by name, mobile or code</label>' +
        '<input class="ui-input" id="ordCustSearch" type="search" autocomplete="off" spellcheck="false" ' +
          'value="' + esc(state.customerQuery) + '">' +
      '</div>' +
      results +
    '</div>';
  }

  function itemsCard() {
    var groups = groupedDressTypes();
    var anyDress = state.dressTypes.length > 0;

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Items</h2>' +
      '<p class="ui-card-sub">One row per garment. The rate box suggests your price list, but the agreed rate is what counts.</p>' +
      (!anyDress
        ? '<div class="empty"><div class="empty-title">No dress types yet</div>' +
          '<p class="empty-text">Add dress types under Settings first, then come back and build the order.</p></div>'
        : '') +
      (anyDress ? '<div class="table-wrap"><table class="ui-table ord-items">' +
        '<thead><tr>' +
          '<th>Dress</th><th>Service</th><th>Variant</th><th>Lining</th>' +
          '<th class="num">Qty</th><th class="num">Rate</th><th class="num">Extra</th>' +
          '<th class="num">Total</th><th>Delivery</th><th>Measurements</th><th></th>' +
        '</tr></thead>' +
        '<tbody>' + state.formItems.map(function (it, i) {
          return itemRow(it, i, groups);
        }).join('') + '</tbody>' +
        '</table></div>' : '') +
      (anyDress
        ? '<div class="ord-add-row">' +
            '<button class="btn btn-secondary" id="ordAddItem"' +
              (state.formItems.length >= MAX_ITEMS ? ' disabled' : '') + '>+ Add item</button>' +
            '<span class="ui-hint">' + state.formItems.length + ' of ' + MAX_ITEMS + ' items</span>' +
          '</div>'
        : '') +
    '</div>';
  }

  function itemRow(it, i, groups) {
    var dressOpts = ['<option value="">Choose a dress</option>'];
    ['Gents', 'Ladies', 'Other'].forEach(function (cat) {
      if (!groups[cat].length) return;
      dressOpts.push('<optgroup label="' + esc(cat) + '">');
      groups[cat].forEach(function (name) {
        dressOpts.push('<option value="' + esc(name) + '"' + (name === it.dress_type ? ' selected' : '') + '>' + esc(name) + '</option>');
      });
      dressOpts.push('</optgroup>');
    });

    var mOpts = ['<option value="">None</option>'];
    state.measurements.forEach(function (m) {
      var label = m.code + ' · ' + m.dress_type + ' · ' + dateLabel(m.created_at);
      mOpts.push('<option value="' + esc(m.id) + '"' + (m.id === it.measurement_id ? ' selected' : '') + '>' + esc(label) + '</option>');
    });

    return '<tr>' +
      '<td><select class="ui-input" data-ord-item="' + i + '" data-f="dress_type">' + dressOpts.join('') + '</select></td>' +
      '<td><select class="ui-input" data-ord-item="' + i + '" data-f="service">' +
          SERVICES.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === it.service ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select></td>' +
      '<td><input class="ui-input" data-ord-item="' + i + '" data-f="variant" value="' + esc(it.variant || '') + '" placeholder="e.g. Full sleeve"></td>' +
      '<td><input class="ui-input" data-ord-item="' + i + '" data-f="lining" value="' + esc(it.lining || '') + '" placeholder="e.g. Cotton"></td>' +
      '<td class="num"><input class="ui-input" data-ord-item="' + i + '" data-f="qty" inputmode="decimal" value="' + esc(it.qty) + '"></td>' +
      '<td class="num"><input class="ui-input" data-ord-item="' + i + '" data-f="rate" inputmode="decimal" list="ordPriceList" value="' + esc(it.rate) + '"></td>' +
      '<td class="num"><input class="ui-input" data-ord-item="' + i + '" data-f="extra" inputmode="decimal" value="' + esc(it.extra) + '"></td>' +
      '<td class="num"><strong>' + money(lineTotal(it)) + '</strong></td>' +
      '<td><input class="ui-input" data-ord-item="' + i + '" data-f="delivery_date" type="date" value="' + esc(it.delivery_date || '') + '"></td>' +
      '<td><select class="ui-input" data-ord-item="' + i + '" data-f="measurement_id">' + mOpts.join('') + '</select></td>' +
      '<td><button class="btn btn-sm btn-danger" data-ord-rm="' + i + '" title="Remove item">&times;</button></td>' +
    '</tr>';
  }

  function priceDatalist() {
    if (!state.prices.length) return '';
    return '<datalist id="ordPriceList">' +
      state.prices.map(function (p) {
        var label = p.item + (p.option ? ' - ' + p.option : '') + ' (' + money(p.amount) + ')';
        return '<option value="' + money(p.amount) + '">' + esc(label) + '</option>';
      }).join('') +
    '</datalist>';
  }

  function totalsCard(order, t) {
    var editing = state.form !== 'new';

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Order details</h2>' +
      priceDatalist() +
      '<div class="form-grid">' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="ordDate">Order date</label>' +
          '<input class="ui-input" id="ordDate" type="date" value="' + esc(editing ? order.order_date : today()) + '">' +
        '</div>' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="ordDiscount">Discount (whole order)</label>' +
          '<input class="ui-input" id="ordDiscount" inputmode="decimal" value="' +
            esc(editing ? num(order.discount) : 0) + '">' +
        '</div>' +
        (editing
          ? '<div class="ui-field">' +
              '<label class="ui-label" for="ordAdvance">Advance received</label>' +
              '<input class="ui-input" id="ordAdvance" value="' + money(order.advance) + '" disabled>' +
              '<p class="ui-hint">Changed from Payments, so the balance and the payment history always agree.</p>' +
            '</div>'
          : '<div class="ui-field">' +
              '<label class="ui-label" for="ordAdvance">Advance received</label>' +
              '<input class="ui-input" id="ordAdvance" inputmode="decimal" value="0">' +
              '<p class="ui-hint">Enter 0 if nothing was paid yet.</p>' +
            '</div>') +
        (editing ? '' :
          '<div class="ui-field">' +
            '<label class="ui-label" for="ordMethod">Advance paid by</label>' +
            '<select class="ui-input" id="ordMethod">' +
              ['CASH', 'UPI', 'BANK', 'OTHER'].map(function (m) {
                return '<option value="' + m + '">' + m + '</option>';
              }).join('') +
            '</select>' +
            '<p class="ui-hint">Only needed when an advance is entered.</p>' +
          '</div>') +
        '<div class="ui-field span-2">' +
          '<label class="ui-label" for="ordNotes">Notes</label>' +
          '<textarea class="ui-textarea" id="ordNotes" placeholder="Fabric, style, anything the cutter should know">' +
            esc(editing ? order.notes : '') +
          '</textarea>' +
        '</div>' +
      '</div>' +
      '<div class="ord-totals">' +
        '<div class="ord-total"><span>Total</span><strong>' + money(t.total) + '</strong></div>' +
        '<div class="ord-total"><span>Discount</span><strong>- ' + money(t.discount) + '</strong></div>' +
        '<div class="ord-total"><span>Advance</span><strong>- ' + money(t.advance) + '</strong></div>' +
        '<div class="ord-total ord-total-balance"><span>Balance due</span><strong>' + money(t.balance) + '</strong></div>' +
      '</div>' +
    '</div>';
  }

  function saveBar(editing) {
    return '<div class="form-actions ord-save-bar">' +
      '<button class="btn btn-primary" id="ordSave"' + (state.saving ? ' disabled' : '') + '>' +
        (state.saving ? 'Saving...' : 'Save order') +
      '</button>' +
      '<button class="btn btn-secondary" id="ordCancel">Cancel</button>' +
    '</div>';
  }

  /* Item model ---------------------------------------------------------- */

  function blankItem() {
    return {
      category: '',
      dress_type: '',
      service: 'Tailoring',
      variant: '',
      lining: '',
      qty: 1,
      rate: 0,
      extra: 0,
      delivery_date: '',
      measurement_id: ''
    };
  }

  // Keeps qty, rate and extra to one decimal place and one leading minus, and
  // refuses to let a stray character turn a rate into nonsense. Money is
  // accepted as text so the tailor can clear a box mid-typing.
  function numField(value) {
    var s = String(value == null ? '' : value).replace(/[^0-9.-]/g, '');
    var neg = s.charAt(0) === '-';
    s = s.replace(/-/g, '');
    var parts = s.split('.');
    if (parts.length > 2) s = parts[0] + '.' + parts.slice(1).join('');
    if (parts.length > 1) s = parts[0] + '.' + parts[1].slice(0, 2);
    return (neg ? '-' : '') + s;
  }

  function readItems() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-item]'), function (el) {
      var i = parseInt(el.getAttribute('data-ord-item'), 10);
      var f = el.getAttribute('data-f');
      if (isNaN(i) || !state.formItems[i]) return;
      var v = el.value;
      if (f === 'qty' || f === 'rate' || f === 'extra') {
        state.formItems[i][f] = numField(v);
        var cleaned = numField(v);
        if (el.value !== cleaned) {
          var atEnd = el.selectionStart === el.value.length;
          el.value = cleaned;
          if (atEnd) {
            try { el.setSelectionRange(cleaned.length, cleaned.length); } catch (err) {}
          }
        }
      } else {
        state.formItems[i][f] = v;
      }
    });
  }

  function validate() {
    var order = state.form === 'new' ? null : state.form;
    var dateEl = byId('ordDate');
    var discountEl = byId('ordDiscount');

    // A new order must be attached to a customer before anything else is
    // touched. Without this the save reached the point of reading
    // state.formCustomer.id with nothing selected and threw, which left the
    // button stuck on "Saving...".
    if (!order && !state.formCustomer) {
      return 'Choose a customer for this order.';
    }

    var orderDate = dateEl ? dateEl.value.trim() : '';
    if (!orderDate) return 'Choose the order date.';

    var items = state.formItems;

    if (!items.length) return 'Add at least one item to the order.';
    if (items.length > MAX_ITEMS) return 'An order cannot contain more than ' + MAX_ITEMS + ' items.';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var n = i + 1;
      if (!it.dress_type) return 'Choose a dress type for item ' + n + '.';
      if (!it.service) return 'Choose a service for item ' + n + '.';
      if (num(it.qty) <= 0) return 'Quantity must be more than zero for item ' + n + '.';
      if (num(it.rate) < 0) return 'Rate cannot be negative for item ' + n + '.';
      if (num(it.extra) < 0) return 'Extra charge cannot be negative for item ' + n + '.';
      if (!it.delivery_date) return 'Give a delivery date for item ' + n + '.';
    }

    var t = totalsOf(items, numField(discountEl ? discountEl.value : 0), order ? order.advance : 0);
    if (t.discount > t.total) return 'The discount cannot be more than the order total of ' + money(t.total) + '.';

    var advance = 0;
    if (!order) {
      var advEl = byId('ordAdvance');
      advance = num(numField(advEl ? advEl.value : 0));
      if (advance < 0) return 'The advance cannot be negative.';
      if (advance > t.total - t.discount) {
        return 'The advance cannot be more than ' + money(t.total - t.discount) + '.';
      }
    }

    return null;
  }

  function collectOrderFields() {
    var order = state.form === 'new' ? null : state.form;
    var dateEl = byId('ordDate');
    var discountEl = byId('ordDiscount');
    var notesEl = byId('ordNotes');
    var advEl = byId('ordAdvance');
    var methodEl = byId('ordMethod');
    var statusEl = byId('ordStatusEdit');
    var priorityEl = byId('ordPriorityEdit');

    return {
      order_date: dateEl ? dateEl.value.trim() : today(),
      discount: num(numField(discountEl ? discountEl.value : 0)),
      advance: order ? num(order.advance) : num(numField(advEl ? advEl.value : 0)),
      method: methodEl ? methodEl.value : 'CASH',
      notes: notesEl ? notesEl.value.trim() : '',
      status: statusEl ? statusEl.value : 'Pending',
      priority: priorityEl ? priorityEl.value : 'Normal'
    };
  }

  function itemPayload(it, orderId, lineNo) {
    var dress = it.dress_type;
    var groups = groupedDressTypes();
    var category = 'Gents';
    if (groups.Ladies.indexOf(dress) !== -1) category = 'Ladies';
    else if (groups.Gents.indexOf(dress) === -1) category = dress ? 'Other' : '';

    var row = {
      order_id: orderId,
      line_no: lineNo,
      category: category,
      dress_type: dress,
      service: it.service,
      variant: it.variant || '',
      lining: it.lining || '',
      quantity: num(it.qty),
      rate: num(it.rate),
      discount: 0,
      extra_charge: num(it.extra),
      line_total: lineTotal(it),
      delivery_date: it.delivery_date,
      measurement_id: it.measurement_id || null,
      updated_at: new Date().toISOString()
    };
    return row;
  }

  function save() {
    if (state.saving) return;

    readItems();
    var problem = validate();
    if (problem) return toast(problem, 'error');

    var editing = state.form !== 'new';
    var f = collectOrderFields();
    var t = totalsOf(state.formItems, f.discount, f.advance);
    var orderId = editing ? state.form.id : null;

    state.saving = true;
    state.saveError = '';
    paint();

    // Watchdog. A request that never settles -- a dropped connection mid-save,
    // or a promise that rejects before the catch is attached -- must not leave
    // the button disabled for the rest of the shift.
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      if (!state.saving) return;
      state.saving = false;
      paint();
      toast('The save did not finish. Check the connection and try again.', 'error');
    }, 25000);

    var head = {
      order_date: f.order_date,
      delivery_date: latestDelivery(state.formItems) || null,
      status: editing ? f.status : 'Pending',
      priority: editing ? f.priority : 'Normal',
      total: t.total,
      advance: t.advance,
      discount: t.discount,
      balance: t.balance,
      notes: f.notes,
      line_model: 'ITEMS',
      item_count: state.formItems.length,
      updated_at: new Date().toISOString()
    };

    if (!editing) {
      head.customer_id = state.formCustomer.id;
      head.order_date = f.order_date;
    }

    var work;

    // Anything thrown from here on is a coding fault rather than a rejected
    // request, so it would escape the promise chain below. The button is
    // already disabled at this point, which is exactly how it got stuck before.
    try {
      if (editing) {
        // The parent measurement_id mirrors the first item, matching the legacy
        // sheet where the parent row held the first item's measurement.
        head.measurement_id = state.formItems[0] && state.formItems[0].measurement_id
          ? state.formItems[0].measurement_id
          : null;

        work = sb().from('orders')
          .update(head)
          .eq('id', orderId)
          .select('id,code')
          .then(guardEmpty('That order could not be changed.'))
          // Stop here if the update was refused. Carrying on would rewrite the
          // item lines of an order that was never actually changed.
          .then(function (res) {
            if (res && res.error) return res;
            return syncItems(orderId);
          });
      } else {
        work = nextCode().then(function (code) {
          if (!code) return { error: { message: 'Could not work out a new order number. Try again.' } };
          head.code = code;
          return sb().from('orders')
            .insert(head)
            .single()
            .then(function (res) {
              if (res.error || !res.data) {
                return { error: res.error || { message: 'The order could not be saved.' } };
              }
              orderId = res.data.id;
              return replaceItems(orderId);
            });
        });
      }
    } catch (e) {
      failSave(e, orderId);
      return;
    }

    work
      .then(function (res) {
        if (res && res.error) throw res.error;
        // An advance is money received, so it belongs in payments. Without this
        // row the Payments page and the customer's balance would disagree with
        // the order, which is the drift the legacy repair tool existed to fix.
        if (!editing && f.advance > 0) return recordAdvancePayment(orderId, t, f);
        return null;
      })
      .then(function () {
        clearTimeout(saveTimer);
        state.saving = false;
        state.view = 'list';
        state.form = null;
        state.formItems = [];
        state.page = 0;
        toast('Order saved', 'success');
        return loadOrders();
      })
      .catch(function (err) {
        failSave(err, orderId);
      });
  }

  // Single place that clears the saving flag, so no failure path can leave the
  // button stuck.
  function failSave(err, orderId) {
    clearTimeout(saveTimer);
    state.saving = false;
    var msg = (err && err.message) || 'The order could not be saved.';
    // The order row is in place even if the items failed, so say so rather
    // than letting the tailor enter the whole order again.
    toast(orderId ? 'Order saved but the items failed: ' + msg : msg, 'error');
    state.saveError = msg;
    paint();
  }

  function guardEmpty(message) {
    return function (res) {
      if (res.error) return res;
      if (!res.data || res.data.length === 0) {
        return { error: { message: message } };
      }
      return res;
    };
  }

  function nextCode() {
    return sb().from('orders')
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
        return 'ORD-' + String(n).padStart(4, '0');
      });
  }

  // New order: every row is an insert, so it is one request. The count is
  // checked because PostgREST answers a multi-row insert with 201 even when RLS
  // dropped every row, and an order silently missing its items is worse than an
  // error the tailor can see.
  function replaceItems(orderId) {
    var rows = state.formItems.map(function (it, i) {
      return itemPayload(it, orderId, i + 1);
    });

    return sb().from('order_items')
      .insert(rows)
      .select('id')
      .then(function (res) {
        if (res.error) {
          return { error: { message: 'The order was created but its items were not saved: ' +
            (res.error.message || 'the item rows were rejected.') } };
        }
        var written = (res.data || []).length;
        if (written !== rows.length) {
          return { error: { message: 'Only ' + written + ' of ' + rows.length +
            ' items were saved. Open the order and add the rest.' } };
        }
        return null;
      });
  }

  // Editing an order has to cope with the fact that staff may not hard-delete a
  // line. Lines that disappeared are archived when the user is staff and truly
  // removed when the user is the owner, so the audit trail rule stays intact.
  //
  // The steps run one after another rather than all at once. Sending them
  // together would let a failed insert land after a successful delete and leave
  // the order half written.
  function syncItems(orderId) {
    var existing = state.items[orderId] || [];
    var keep = state.formItems.filter(function (i) { return i.id; });
    var keepIds = keep.map(function (i) { return i.id; });
    var removed = existing.filter(function (e) { return keepIds.indexOf(e.id) === -1; });
    var now = new Date().toISOString();

    // A step is { want: rows, query }. "want" is how many rows the server must
    // report back, so a write silently dropped by RLS is caught rather than
    // treated as a success.
    var steps = [];

    removed.forEach(function (e) {
      steps.push({
        want: 1,
        query: isOwner()
          ? sb().from('order_items').delete().eq('id', e.id).select('id')
          : sb().from('order_items')
              .update({ archived_at: now, updated_at: now })
              .eq('id', e.id)
              .select('id')
      });
    });

    state.formItems.forEach(function (it, i) {
      var payload = itemPayload(it, orderId, i + 1);
      if (it.id) {
        delete payload.order_id;
        steps.push({ want: 1, query: sb().from('order_items').update(payload).eq('id', it.id).select('id') });
      } else {
        steps.push({ want: 1, query: sb().from('order_items').insert(payload).select('id') });
      }
    });

    if (!steps.length) return Promise.resolve(null);

    return steps.reduce(function (chain, step) {
      return chain.then(function (acc) {
        if (acc && acc.error) return acc;
        return step.query.then(function (res) {
          if (res.error) {
            return { error: { message: res.error.message || 'An item could not be saved.' } };
          }
          var written = (res.data || []).length;
          if (written !== step.want) {
            return { error: { message: 'An item was not saved. It may have been rejected. Open the order and check the items.' } };
          }
          return null;
        });
      });
    }, Promise.resolve(null));
  }

  // payments.code is NOT NULL with no default, so the number has to exist
  // before the insert. Generating it afterwards could never work.
  // .single() is required as well: without it the client asks PostgREST for
  // return=minimal and gets no row back, so a successful insert would be
  // indistinguishable from a rejected one.
  function recordAdvancePayment(orderId, t, f, attempt) {
    if (!orderId) {
      return { error: { message: 'The order was not saved, so the advance was not recorded.' } };
    }

    return nextPaymentCode().then(function (code) {
      return sb().from('payments')
        .insert({
          code: code,
          order_id: orderId,
          customer_id: state.formCustomer.id,
          amount: t.advance,
          method: f.method,
          previous_balance: round2(t.total - t.discount),
          new_balance: t.balance,
          notes: 'Advance at order (' + orderId.slice(0, 8) + ')',
          paid_on: f.order_date
        })
        .single()
        .then(function (res) {
          if (res.error) {
            // Two tails can pick the same number. Take the next one and retry
            // rather than losing the money record.
            if (res.error.status === 409 && (attempt || 0) < 3) {
              return recordAdvancePayment(orderId, t, f, (attempt || 0) + 1);
            }
            return {
              error: {
                message: 'The order was saved but the advance could not be recorded as a payment: ' +
                  (res.error.message || 'the payment row was rejected.')
              }
            };
          }
          return null;
        });
    });
  }

  function nextPaymentCode() {
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

  /* Loading a single order into the form --------------------------------- */

  function openOrder(id) {
    state.loading = true;
    paint();

    sb().from('orders')
      .select('*, customer:customers(id,code,name,mobile)')
      .eq('id', id)
      .maybeSingle()
      .then(function (res) {
        if (res.error || !res.data) {
          state.loading = false;
          state.error = res.error ? res.error.message : 'That order could not be found.';
          state.view = 'list';
          return paint();
        }

        var order = res.data;
        return sb().from('order_items')
          .select('*')
          .eq('order_id', order.id)
          .is('archived_at', null)
          .order('line_no', true)
          .then(function (itemRes) {
            state.loading = false;
            if (itemRes.error) {
              state.error = itemRes.error.message;
              state.view = 'list';
              return paint();
            }

            state.form = order;

            // Keep the rows as they came from the database. syncItems() needs
            // them to work out which lines the tailor deleted: without this the
            // "removed" set is always empty and deleting a line would leave it
            // in the database with no warning.
            state.items[order.id] = itemRes.data || [];

            state.formItems = (itemRes.data || []).map(function (it) {
              return {
                id: it.id,
                category: it.category,
                dress_type: it.dress_type,
                service: it.service || 'Tailoring',
                variant: it.variant,
                lining: it.lining,
                qty: it.quantity,
                rate: it.rate,
                extra: it.extra_charge,
                delivery_date: it.delivery_date || '',
                measurement_id: it.measurement_id || ''
              };
            });
            if (!state.formItems.length) state.formItems = [blankItem()];

            state.formCustomer = order.customer || null;
            state.view = 'edit';
            return loadReference()
              .then(loadPrices)
              .then(function () { return loadMeasurements(order.customer_id); })
              .then(paint);
          });
      });
  }

  function startNew() {
    state.form = 'new';
    state.formItems = [blankItem()];
    state.formCustomer = null;
    state.customerQuery = '';
    state.customers = [];
    state.measurements = [];
    state.view = 'edit';
    loadReference().then(loadPrices).then(paint);
  }

  function searchCustomers(term) {
    var t = String(term || '').trim();
    if (t.length < 1) return Promise.resolve();

    var clean = '*' + t.replace(/[*%,()]/g, ' ') + '*';
    return sb().from('customers')
      .select('id,code,name,mobile')
      .or('name.ilike.' + clean + ',mobile.ilike.' + clean + ',code.ilike.' + clean)
      .order('name', true)
      .limit(8)
      .then(function (res) {
        state.customers = (res && !res.error && res.data) || [];
        paint();
      });
  }

  function removeOrder() {
    var order = state.form;
    if (!order || !window.confirm('Delete order ' + order.code + ' and all its items? This cannot be undone.')) return;

    sb().from('orders')
      .delete()
      .eq('id', order.id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        if (!res.data || res.data.length === 0) {
          return toast('That order could not be deleted. Only the Owner can remove an order.', 'error');
        }
        toast('Order deleted', 'success');
        state.view = 'list';
        state.form = null;
        return loadOrders();
      });
  }

  /* Events --------------------------------------------------------------- */

  function wire() {
    if (state.view === 'list') wireList();
    else wireEdit();
  }

  function wireList() {
    var add = byId('ordNew');
    if (add) {
      add.addEventListener('click', function () {
        startNew();
      });
    }

    var search = byId('ordSearch');
    if (search) {
      search.addEventListener('input', function (e) {
        state.search = e.target.value;
        state.page = 0;
        if (custTimer) window.clearTimeout(custTimer);
        custTimer = window.setTimeout(function () {
          loadOrders().then(function () {
            var again = byId('ordSearch');
            if (again) {
              again.value = state.search;
              again.focus();
              try { again.setSelectionRange(state.search.length, state.search.length); } catch (err) {}
            }
          });
        }, 300);
      });
    }

    var status = byId('ordStatus');
    if (status) {
      status.addEventListener('change', function () {
        state.status = status.value;
        state.page = 0;
        loadOrders();
      });
    }

    var prev = byId('ordPrev');
    if (prev) {
      prev.addEventListener('click', function () {
        if (state.page === 0) return;
        state.page -= 1;
        loadOrders();
      });
    }

    var next = byId('ordNext');
    if (next) {
      next.addEventListener('click', function () {
        state.page += 1;
        loadOrders();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-open]'), function (btn) {
      btn.addEventListener('click', function () {
        openOrder(btn.getAttribute('data-ord-open'));
      });
    });
  }

  function wireEdit() {
    var back = byId('ordBack');
    if (back) back.addEventListener('click', closeEdit);

    var cancel = byId('ordCancel');
    if (cancel) cancel.addEventListener('click', closeEdit);

    var del = byId('ordDelete');
    if (del) del.addEventListener('click', removeOrder);

    var saveBtn = byId('ordSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        save();
      });
    }

    var custSearch = byId('ordCustSearch');
    if (custSearch) {
      custSearch.addEventListener('input', function (e) {
        state.customerQuery = e.target.value;
        if (custTimer) window.clearTimeout(custTimer);
        custTimer = window.setTimeout(function () {
          searchCustomers(state.customerQuery).then(function () {
            var again = byId('ordCustSearch');
            if (again) {
              again.value = state.customerQuery;
              again.focus();
              try { again.setSelectionRange(state.customerQuery.length, state.customerQuery.length); } catch (err) {}
            }
          });
        }, 260);
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-cust]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ord-cust');
        var found = state.customers.filter(function (c) { return c.id === id; })[0];
        if (!found) return;
        state.formCustomer = found;
        state.customerQuery = found.name;
        state.customers = [];
        loadMeasurements(found.id).then(paint);
      });
    });

    var addItem = byId('ordAddItem');
    if (addItem) {
      addItem.addEventListener('click', function () {
        readItems();
        if (state.formItems.length >= MAX_ITEMS) {
          return toast('An order cannot contain more than ' + MAX_ITEMS + ' items.', 'error');
        }
        state.formItems.push(blankItem());
        paint();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-rm]'), function (btn) {
      btn.addEventListener('click', function () {
        readItems();
        var i = parseInt(btn.getAttribute('data-ord-rm'), 10);
        if (isNaN(i)) return;
        state.formItems.splice(i, 1);
        if (!state.formItems.length) state.formItems = [blankItem()];
        paint();
      });
    });

    // Any change to an item row refreshes the line total and the order totals.
    // Repainting on every keystroke would move the cursor, so the fields are
    // read into the model on input and only the total cells are rewritten.
    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-item]'), function (el) {
      el.addEventListener('change', function () {
        readItems();
        refreshTotals();
      });
      el.addEventListener('input', function (e) {
        var f = el.getAttribute('data-f');
        if (f === 'qty' || f === 'rate' || f === 'extra') {
          var i = parseInt(el.getAttribute('data-ord-item'), 10);
          if (isNaN(i) || !state.formItems[i]) return;
          var cleaned = numField(el.value);
          if (cleaned === el.value) return;
          var atEnd = el.selectionStart === el.value.length;
          el.value = cleaned;
          if (atEnd) {
            try { el.setSelectionRange(cleaned.length, cleaned.length); } catch (err) {}
          }
          state.formItems[i][f] = cleaned;
          refreshLineTotal(i);
          refreshTotals();
        }
      });
    });

    var discount = byId('ordDiscount');
    if (discount) {
      discount.addEventListener('input', function (e) {
        var cleaned = numField(e.target.value);
        if (cleaned === e.target.value) return;
        var atEnd = e.target.selectionStart === e.target.value.length;
        e.target.value = cleaned;
        if (atEnd) {
          try { e.target.setSelectionRange(cleaned.length, cleaned.length); } catch (err) {}
        }
        refreshTotals();
      });
    }

    var advance = byId('ordAdvance');
    if (advance && state.form === 'new') {
      advance.addEventListener('input', function (e) {
        var cleaned = numField(e.target.value);
        if (cleaned === e.target.value) return;
        var atEnd = e.target.selectionStart === e.target.value.length;
        e.target.value = cleaned;
        if (atEnd) {
          try { e.target.setSelectionRange(cleaned.length, cleaned.length); } catch (err) {}
        }
        refreshTotals();
      });
    }
  }

  function refreshLineTotal(i) {
    var rows = document.querySelectorAll('.ord-items tbody tr');
    var row = rows[i];
    if (!row) return;
    var cell = row.children[7];
    if (cell) cell.innerHTML = '<strong>' + money(lineTotal(state.formItems[i])) + '</strong>';
  }

  function refreshTotals() {
    var order = state.form === 'new' ? null : state.form;
    var discountEl = byId('ordDiscount');
    var advanceEl = byId('ordAdvance');
    var t = totalsOf(
      state.formItems,
      num(numField(discountEl ? discountEl.value : 0)),
      order ? num(order.advance) : num(numField(advanceEl ? advanceEl.value : 0))
    );

    var box = document.querySelector('.ord-totals');
    if (!box) return;
    var values = box.querySelectorAll('.ord-total strong');
    if (values.length < 4) return;
    values[0].textContent = money(t.total);
    values[1].textContent = '- ' + money(t.discount);
    values[2].textContent = '- ' + money(t.advance);
    values[3].textContent = money(t.balance);
  }

  function closeEdit() {
    readItems();
    state.view = 'list';
    state.form = null;
    state.formItems = [];
    state.formCustomer = null;
    state.measurements = [];
    loadOrders();
  }

  return {
    mount: function () {
      return '<div id="ordersView"></div>';
    },

    render: function () {
      state.view = 'list';
      state.search = '';
      state.searchNote = '';
      state.status = '';
      state.page = 0;
      state.orders = [];
      state.items = {};
      state.error = null;
      state.form = null;
      state.formItems = [];
      state.formCustomer = null;
      state.customers = [];
      state.customerQuery = '';
      state.measurements = [];
      state.dressTypes = [];
      state.prices = [];
      paint();
      loadReference().then(loadPrices).then(function () {
        return loadOrders();
      });
    }
  };
})();

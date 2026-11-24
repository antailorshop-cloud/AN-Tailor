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

  var STATUSES = ['Pending', 'Process', 'Finish', 'Delivery', 'Cancelled'];
  // A garment has its own promise and its own progress. Cancelling stays an
  // order-level decision because it changes money, so an item moves only through
  // the four working stages; the parent order keeps its existing five-stage flow.
  var ITEM_FLOW = ['Pending', 'Process', 'Finish', 'Delivery'];
  var PRIORITIES = ['Normal', 'Urgent'];

  // Service and lining lists are taken verbatim from the legacy Orders.html so
  // the shop sees the same words it always has. A renamed option is a different
  // thing in the shop's head, so these are not invented here.
  var SERVICES = [
    'Tailoring',
    'Aari Work',
    'Ironing',
    'Saree Pre-Pleating',
    'Alteration',
    'Embroidery',
    'Resale'
  ];

  var LINING_OPTIONS = ['', 'Without Lining', 'With Lining'];

  // The legacy system only keeps lining for a Tailoring order, and only shows a
  // measurement when a measurement can actually apply. These two predicates
  // drive which columns a row shows, so the rule lives in one place instead of
  // being repeated in every branch.
  function isTailoring(service) {
    return service === 'Tailoring';
  }

  function isResale(service) {
    return service === 'Resale';
  }
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
    // An order that already exists is read only for everyone but the owner, so
    // a saved order cannot be changed out from under the shopkeeper. New orders
    // are always writable, because anyone taking work in has to be able to enter it.
    readonly: false,
    formItems: [],
    formCustomer: null,
    customers: [],
    customerQuery: '',
    dressTypes: [],
    resale: [],
    measurements: [],
    // Service prices from the price portal. For services like Alteration, Aari
    // Work, Ironing, Saree Pre-Pleating and Embroidery the configured price is
    // the starting price, so an order cannot be saved below it.
    prices: [],
    // The shop name and the ready-message wording, so the WhatsApp button says
    // the shop's own name and the owner's own words. Kept apart from state.form
    // because it belongs to the list as well as the order.
    waShop: { name: '', waReadyMessage: '', upiId: '', payee: '',
      gstEnabled: '', gstin: '', gstState: '', gstTailoringRate: '',
      gstResaleLowRate: '', gstResaleHighRate: '', gstGarmentHsn: '',
      gstServiceSac: '' },
    saving: false,
    saveError: '',
    // Carried from the Customers screen into the next New order form, so the
    // tailor does not have to find the same person a second time.
    pendingCustomer: null,
    pendingCustomerId: null,
    // Last delivery date typed on this form. New rows copy it, and the Apply to
    // all button writes it to every row at once.
    lastDelivery: '',
    quickCustomerForm: false
  };

  var custTimer = null;
  var saveTimer = null;
  // Set when a measurement saved on the Measurements page belongs on a row in
  // this unsaved order. Consumed by render() once the route comes back here.
  var pendingMeasurement = null;

  function me() {
    return window.ANT.auth.current() || {};
  }

  function isOwner() {
    return me().role === 'owner';
  }

  // The attribute string that locks a control in a read-only order. Kept in one
  // place so every field on the form locks (or unlocks) together.
  function roAttr() {
    return state.readonly ? ' disabled' : '';
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
      'Process': 'chip-info',
      'Finish': 'chip-info',
      'Delivery': 'chip-success',
      'Cancelled': 'chip-muted'
    }[status] || 'chip-muted';
    return '<span class="chip ' + kind + '">' + esc(status) + '</span>';
  }

  // Older rows have no item status, and a bad value must never put a button on
  // screen that would be rejected by the enum. Both normalise to Pending.
  function itemStatus(it) {
    var s = it && it.status;
    return ITEM_FLOW.indexOf(s) !== -1 ? s : 'Pending';
  }

  function itemStatusChip(status) {
    return statusChip(ITEM_FLOW.indexOf(status) !== -1 ? status : 'Pending');
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

  /* The GST breakdown is the same calculation the Bills page uses, run over the
   * rows currently on the form. Prices are inclusive, so this shows how much of
   * each entered price is tax; it never changes the figures saved on the order. */
  function gstForForm(discount) {
    var bills = window.ANT.bills;
    if (!bills || typeof bills.gstForOrders !== 'function') return null;

    var items = (state.formItems || []).map(function (it) {
      return {
        service: it.service || '',
        variant: it.resale_item || it.variant || '',
        rate: num(it.rate),
        quantity: num(it.qty),
        line_total: lineTotal(it)
      };
    });

    return bills.gstForOrders(
      [{ discount: num(discount), items: items }],
      state.waShop || {}
    );
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

  // Resale items come from stock, and only what is actually left is offered:
  // bought minus sold. The arithmetic is owned by the resale module rather than
  // repeated here, because the stock page shows the same figure and two
  // definitions of "available" would eventually disagree on whether a garment
  // can be sold twice.
  function loadResale() {
    if (!window.ANT.resale || !window.ANT.resale.load) {
      console.warn('Orders: scripts/resale.js did not load, so a Resale order has no item to pick.');
      toast('Resale stock unavailable.', 'error');
      return Promise.resolve();
    }

    return window.ANT.resale.load()
      .then(function (view) {
        // One row per item name, with the id stored on the order line. An item
        // bought in twice has two ids and the first is kept, which is all the
        // line needs, because availability is worked out by name.
        state.resale = (view || []).map(function (r) {
          return {
            id: r.ids && r.ids.length ? r.ids[0] : null,
            item: r.item,
            sell_price: r.sell_price,
            bought: r.bought,
            sold: r.sold,
            available: r.available
          };
        });
      })
      .catch(function (e) {
        // If sold cannot be read, availability cannot be trusted. The list is
        // left empty rather than offering the whole ledger, because offering
        // stock that is already gone is the one mistake worth refusing to guess
        // about.
        console.warn('Orders: resale stock could not be loaded, so a Resale order has no item to pick.', e);
        toast('Resale stock unavailable.', 'error');
        state.resale = [];
      });
  }

  // Service starting prices come from the price portal. For a service like
  // Alteration or Aari Work the price entered there is the minimum rate: the
  // shop can charge more, never less.
  function loadPrices() {
    return sb().from('prices')
      .select('group_name,item,option,price,status')
      .eq('status', 'ACTIVE')
      .then(function (res) {
        if (res.error) {
          console.warn('Orders: prices could not be loaded.', res.error.message);
          return;
        }
        state.prices = res.data || [];
      });
  }

  // The starting price for a row, or 0 when no floor applies. SERVICE prices
  // (Alteration, Aari Work, etc.) are keyed by service name. TAILORING prices
  // are keyed by dress type and lining option, so "Blouse / With Lining" and
  // "Blouse / Without Lining" can have different floors. Resale comes from
  // stock sell price and is handled separately.
  function startingPriceFor(service, dressType, lining) {
    if (!service || isResale(service)) return 0;

    var prices = state.prices || [];
    var svc = String(service).trim();
    var svcLower = svc.toLowerCase();

    if (isTailoring(service)) {
      var dress = String(dressType || '').trim().toLowerCase();
      if (!dress) return 0;

      var liningWant = String(lining || '').trim().toLowerCase();
      if (liningWant === '' || liningWant === 'none') liningWant = 'without lining';

      var tRow = prices.filter(function (p) {
        if (String(p.group_name || '').toUpperCase() !== 'TAILORING') return false;
        if (String(p.item || '').trim().toLowerCase() !== dress) return false;
        var opt = String(p.option || '').trim().toLowerCase();
        if (opt === '-') opt = '';
        return opt === liningWant;
      })[0];

      var tFloor = tRow ? num(tRow.price) : 0;
      return tFloor > 0 ? tFloor : 0;
    }

    var row = prices.filter(function (p) {
      return String(p.group_name || '').toUpperCase() === 'SERVICE'
        && String(p.item || '').trim().toLowerCase() === svcLower
        && (p.option == null || String(p.option).trim() === '' || String(p.option).trim() === '-');
    })[0];
    var floor = row ? num(row.price) : 0;
    return floor > 0 ? floor : 0;
  }

  function resaleById(id) {
    if (!id) return null;
    return state.resale.filter(function (r) { return r.id === id; })[0] || null;
  }

  function availableResale() {
    // Rows are already grouped by item name by the resale module, because the
    // same garment can be bought in more than one restock.
    return state.resale
      // Nothing left means nothing to sell, so it is not offered. This is the
      // legacy rule: getResaleSellPriceMap only carried bought minus sold, and
      // without it a tailor can sell the same saree twice.
      .filter(function (r) { return num(r.available) > 0; })
      .map(function (r) {
        return { item: r.item, qty: num(r.available), sell_price: num(r.sell_price) };
      })
      .sort(function (a, b) { return a.item < b.item ? -1 : 1; });
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

  /* The shop name, the owner's ready-message wording and the GST settings, read
   * once for the page. A failure here only costs the WhatsApp button its custom
   * wording and the totals card its GST breakdown, so it is logged rather than
   * thrown: a tailor should still be able to open an order when the settings
   * table is unhappy. */
  function loadWaShop() {
    return sb().from('shop_settings')
      .select('key,value')
      .then(function (res) {
        if (res && res.error) {
          console.warn('Orders: the shop settings could not be read; the default wording will be used and GST will stay hidden.', res.error);
          return;
        }
        var shop = { name: '', waReadyMessage: '', upiId: '', payee: '',
          gstEnabled: '', gstin: '', gstState: '', gstTailoringRate: '',
          gstResaleLowRate: '', gstResaleHighRate: '', gstGarmentHsn: '',
          gstServiceSac: '' };
        ((res && res.data) || []).forEach(function (row) {
          if (row.key === 'shop_name') shop.name = row.value || '';
          else if (row.key === 'wa_ready_message') shop.waReadyMessage = row.value || '';
          else if (row.key === 'upi_id') shop.upiId = row.value || '';
          else if (row.key === 'upi_payee_name') shop.payee = row.value || '';
          else if (row.key === 'gst_enabled') shop.gstEnabled = row.value || '';
          else if (row.key === 'gstin') shop.gstin = row.value || '';
          else if (row.key === 'gst_state') shop.gstState = row.value || '';
          else if (row.key === 'gst_tailoring_rate') shop.gstTailoringRate = row.value || '';
          else if (row.key === 'gst_resale_low_rate') shop.gstResaleLowRate = row.value || '';
          else if (row.key === 'gst_resale_high_rate') shop.gstResaleHighRate = row.value || '';
          else if (row.key === 'gst_garment_hsn') shop.gstGarmentHsn = row.value || '';
          else if (row.key === 'gst_service_sac') shop.gstServiceSac = row.value || '';
        });
        state.waShop = shop;
      });
  }

  /* List ---------------------------------------------------------------- */

  function loadOrders() {
    state.loading = true;
    paint();

    var from = state.page * PAGE_SIZE;

    function baseQuery() {
      var q = sb().from('orders').select('*, customer:customers(id,code,name,mobile)', { count: true });
      if (state.status) q = q.eq('status', state.status);
      return q.order('order_date', false)
        .order('created_at', false)
        .range(from, from + PAGE_SIZE - 1);
    }

    if (!state.search) return baseQuery().then(finishOrders);

    // A customer's name lives in another table, and this PostgREST version
    // rejects a filter on an embedded table inside or() - it answers 400
    // "failed to parse logic tree", which the browser only shows in the
    // console. So the matching customer ids are looked up first and the order
    // filter then uses the plain customer_id column, which it does support.
    return matchingCustomerIds(state.search).then(function (ids) {
      state.searchNote = ids.length
        ? ''
        : 'No customer matches that name, so only order numbers and notes were searched.';
      return baseQuery().or(searchFilter(state.search, ids)).then(finishOrders);
    });
  }

  // The ids of customers whose name, mobile or code contains the term. Capped so
  // a one-letter search cannot build a filter with thousands of uuids in it.
  function matchingCustomerIds(term) {
    var clean = '*' + String(term).replace(/[*%,()]/g, ' ') + '*';
    return sb().from('customers')
      .select('id')
      .or('name.ilike.' + clean + ',mobile.ilike.' + clean + ',code.ilike.' + clean)
      .limit(200)
      .then(function (res) {
        if (res.error) {
          // Without these ids a search can still match order numbers and notes,
          // so this is a degraded search rather than a broken page.
          console.warn('Orders: customer search failed, so names are not matched.', res.error);
          return [];
        }
        return (res.data || []).map(function (c) { return c.id; });
      });
  }

  // Wrapped in one or=(...) group by the client's own parentheses handling.
  // Every part uses the short col.op.value form, because inside a logic tree
  // PostgREST does not accept the col=op.value form used by top level filters.
  function searchFilter(term, customerIds) {
    var clean = '*' + String(term).replace(/[*%,()]/g, ' ') + '*';
    var parts = [
      'code.ilike.' + clean,
      'notes.ilike.' + clean
    ];

    if (customerIds && customerIds.length) {
      parts.push('customer_id.in.(' + customerIds.join(',') + ')');
    } else {
      // No customer matched, so the only way an order can still qualify is by
      // its own number or notes. customer_id is.null keeps that possible for an
      // order with no customer attached.
      parts.push('customer_id.is.null');
    }

    return parts.join(',');
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
      return o.status !== 'Delivery' && o.status !== 'Cancelled';
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
            '<th class="num">Total</th><th class="num">Balance</th>' +
            '<th>Order status</th><th>Item status</th><th></th>' +
          '</tr></thead>' +
          '<tbody>' + state.orders.map(row).join('') + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  }

  function row(o) {
    var items = state.items[o.id] || [];
    var count = items.length || o.item_count || 0;
    var late = overdue(o.delivery_date) && o.status !== 'Delivery' && o.status !== 'Cancelled';

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
      '<td>' + renderStatusCell(o) + '</td>' +
      '<td>' + renderItemStatusCell(o) + '</td>' +
      '<td class="ord-row-actions">' +
        '<button class="btn btn-sm btn-secondary" data-ord-open="' + esc(o.id) + '">Open</button>' +
        (num(o.balance) > 0 && o.status !== 'Cancelled'
          ? '<button class="btn btn-sm btn-primary" data-ord-pay="' + esc(o.id) + '">Pay</button>'
          : '') +
        '<button class="btn btn-sm btn-secondary" data-ord-bill="' + esc(o.id) + '">Bill</button>' +
        (canTell(o)
          ? '<button class="btn btn-sm btn-secondary" data-ord-tell="' + esc(o.id) + '">Tell customer</button>'
          : '') +
      '</td>' +
    '</tr>';
  }

  /* The "your order is ready" message is only offered on an order that has
   * actually finished and has a mobile to send to. Telling a customer an order
   * is ready when it is still being stitched would be worse than not offering
   * the button at all. */
  function canTell(o) {
    return !!(window.ANT.whatsapp &&
      o.status === 'Finish' &&
      o.customer && window.ANT.whatsapp.canSend(o.customer.mobile));
  }

  /* The order's bill, as a public PDF link, or '' when it is on no bill or the
   * bill could not be drawn. Resolved here so both the ready message and the
   * auto-send share one path, and made to never reject: a bill that cannot be
   * linked must not stop the customer being messaged. */
  function orderBillLink(orderId) {
    if (!orderId) return Promise.resolve('');
    if (window.ANT.bills && typeof window.ANT.bills.orderBillLink === 'function') {
      return window.ANT.bills.orderBillLink(orderId).catch(function () { return ''; });
    }
    return Promise.resolve('');
  }

  /* The bill link is added even when the wording was written by the owner and
   * has no {billBlock} in it, so a custom ready or delivered message still
   * carries the bill. A template that already placed {billBlock} has the link,
   * so it is not appended a second time. */
  function withBillLink(message, billLink) {
    if (!billLink) return message;
    if (message.indexOf(billLink) !== -1) return message;
    return message + '\n\nBill PDF: ' + billLink;
  }

  /* The tap-to-pay line, when the wording the owner wrote does not place
   * {payBlock} itself.
   *
   * A "your order is ready" or "thank you" message must carry the way to pay
   * whenever a balance is still due - that is the moment the link matters most -
   * so it is added the same way the bill link is. A balance already settled adds
   * nothing, and a template that placed {payBlock} or {payLink} itself is not
   * given the line twice. */
  function withPayBlock(message, shop, order, base) {
    if (!message || !window.ANT.whatsapp) return message;

    var t = window.ANT.whatsapp.orderTokens({ shop: shop || {}, order: order || {}, payBase: base });
    if (!t.payLink || message.indexOf(t.payLink) !== -1) return message;
    return message + '\n\n' + t.payBlock;
  }

  /* The ready message is built from the order row itself, which already holds
   * the order number, the delivery date, the balance and the customer's mobile.
   * No extra query is needed and nothing can be retyped wrongly. */
  function tellReady(orderId) {
    if (!window.ANT.whatsapp) return;

    var order = null;
    state.orders.forEach(function (o) { if (o.id === orderId) order = o; });

    if (!order) {
      toast('That order is not on this page.', 'error');
      return;
    }
    if (!order.customer || !window.ANT.whatsapp.canSend(order.customer.mobile)) {
      toast('This customer has no mobile number to send WhatsApp to. ' +
        'Add one on the Customers page.', 'error');
      return;
    }

    var customer = order.customer;

    var open = function (billLink) {
      var message = window.ANT.whatsapp.readyMessage({
        shop: state.waShop,
        customer: customer,
        order: order,
        billLink: billLink || ''
      });
      message = withPayBlock(message, state.waShop, order);
      message = withBillLink(message, billLink);

      var url = window.ANT.whatsapp.link(customer.mobile, message);
      if (!url) {
        toast('That mobile number is not one WhatsApp can use.', 'error');
        return;
      }

      openChat(url);
      toast('Opening WhatsApp for ' + (customer.name || 'this customer') + '.', 'success');
    };

    // The bill, if the order is on one, is looked up - and drawn if it was never
    // shared - before the chat opens, so the message can carry the link.
    orderBillLink(order.id).then(open);
  }

  /* wa.me is handed to the phone by clicking a real anchor, in a new tab, so the
   * app is not navigated away from and the tailor comes back to the same list.
   * Assigning the link to location instead would either leave the shop staring
   * at a "no WhatsApp" page or unload the app. */
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
          ? (state.readonly
              ? 'View only. Only the Owner can change an order once it is created.'
              : 'Changes are saved straight away when you press Save order.')
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
    (state.readonly ? readonlyNote() : saveBar(editing));
  }

  // Shown in place of the save bar on an order the viewer may not change, so it
  // is clear the order is not broken - it is simply locked to the owner.
  function readonlyNote() {
    return '<div class="ui-card ord-readonly-note">' +
      '<p class="ui-hint">This order is view only. Only the Owner can change an order once it has been created. ' +
      'You can still move it along from the Orders list.</p>' +
    '</div>';
  }

  function statusBar(order) {
    return '<div class="ui-card ord-status-bar">' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordStatusEdit">Status</label>' +
        '<select class="ui-input" id="ordStatusEdit"' + roAttr() + '>' +
          STATUSES.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === order.status ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordPriorityEdit">Priority</label>' +
        '<select class="ui-input" id="ordPriorityEdit"' + roAttr() + '>' +
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

    // A walk-in can be added right here. It saves through the Customers module
    // and selects the new row on this form, so the tailor never leaves the order.
    var quick = state.quickCustomerForm
      ? '<div class="ord-quick-cust">' +
          '<div class="form-grid">' +
            '<div class="ui-field">' +
              '<label class="ui-label" for="ordQCName">Name</label>' +
              '<input class="ui-input" id="ordQCName" maxlength="120" autocomplete="off">' +
            '</div>' +
            '<div class="ui-field">' +
              '<label class="ui-label" for="ordQCMobile">Mobile</label>' +
              '<input class="ui-input" id="ordQCMobile" inputmode="tel" autocomplete="off">' +
            '</div>' +
            '<div class="ui-field span-2">' +
              '<label class="ui-label" for="ordQCAddress">Address (optional)</label>' +
              '<input class="ui-input" id="ordQCAddress" autocomplete="off">' +
            '</div>' +
          '</div>' +
          '<div class="form-actions">' +
            '<button class="btn btn-sm btn-primary" id="ordQCSave">Save customer</button>' +
            '<button class="btn btn-sm btn-quiet" id="ordQCCancel">Cancel</button>' +
          '</div>' +
        '</div>'
      : '<button class="btn btn-sm btn-secondary ord-new-cust" id="ordNewCust">+ New customer</button>';

    // Show who is already chosen on a new order. Without this the search box
    // holding their name was the only clue, and it was easy to miss.
    var chosen = state.formCustomer
      ? '<div class="msr-cust ord-selected-cust">' +
          '<div>' +
            '<div class="msr-cust-name">' + esc(state.formCustomer.name || '') + '</div>' +
            '<div class="msr-cust-meta">' + esc(state.formCustomer.code || '') +
              (state.formCustomer.mobile ? ' · ' + esc(state.formCustomer.mobile) : '') +
            '</div>' +
          '</div>' +
        '</div>'
      : '';

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Customer</h2>' +
      '<p class="ui-card-sub">An order always belongs to a customer, so the same person keeps all their orders together.</p>' +
      chosen +
      '<div class="ui-field">' +
        '<label class="ui-label" for="ordCustSearch">Search by name, mobile or code</label>' +
        '<input class="ui-input" id="ordCustSearch" type="search" autocomplete="off" spellcheck="false" ' +
          'value="' + esc(state.customerQuery) + '">' +
      '</div>' +
      results +
      quick +
    '</div>';
  }

  function itemsCard() {
    var groups = groupedDressTypes();
    var anyDress = state.dressTypes.length > 0;

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Items</h2>' +
      '<p class="ui-card-sub">One row per garment. The rate box suggests your price list, but the agreed rate is what counts. ' +
      'On a Resale row, choose only the stock item; the garment HSN comes from GST settings.</p>' +
      (!anyDress
        ? '<div class="empty"><div class="empty-title">No dress types yet</div>' +
          '<p class="empty-text">Add dress types under Settings first, then come back and build the order.</p></div>'
        : '') +
      (anyDress ? '<div class="table-wrap"><table class="ui-table ord-items">' +
        '<thead><tr>' +
          '<th>Service</th><th>Dress</th><th>Lining</th><th>Resale item</th>' +
          '<th class="num">Qty</th><th class="num">Rate</th><th class="num">Extra</th>' +
          '<th class="num">Total</th><th>Delivery</th><th>Status</th><th>Measurements</th><th></th>' +
        '</tr></thead>' +
        '<tbody>' + state.formItems.map(function (it, i) {
          return itemRow(it, i, groups);
        }).join('') + '</tbody>' +
        '</table></div>' : '') +
      (anyDress && !state.readonly && state.formItems.length
        ? '<div class="ord-items-tools">' +
            '<div class="ui-field">' +
              '<label class="ui-label" for="ordApplyDate">Delivery date for all items</label>' +
              '<input class="ui-input" id="ordApplyDate" type="date" value="' + esc(state.lastDelivery) + '">' +
            '</div>' +
            '<button class="btn btn-sm btn-secondary" id="ordApplyDateAll">Apply to all items</button>' +
            '<span class="ui-hint">New rows also copy the last date you entered.</span>' +
          '</div>'
        : '') +
      (anyDress && !state.readonly
        ? '<div class="ord-add-row">' +
            '<button class="btn btn-secondary" id="ordAddItem"' +
              (state.formItems.length >= MAX_ITEMS ? ' disabled' : '') + '>+ Add item</button>' +
            '<span class="ui-hint">' + state.formItems.length + ' of ' + MAX_ITEMS + ' items</span>' +
          '</div>'
        : '') +
    '</div>';
  }

  // The columns a row shows depend on the service, matching the legacy editor:
  //   Tailoring  -> dress, lining, measurement
  //   Resale     -> stock item only; the rate is its sell price and the HSN is
  //                 the one garment HSN typed into GST settings
  //   anything else (Aari Work, Ironing, Saree Pre-Pleating, Alteration,
  //   Embroidery) -> dress and delivery date, with no lining or measurement,
  //   because none of them describe a garment being cut
  function itemRow(it, i, groups) {
    var service = it.service || 'Tailoring';
    var tailoring = isTailoring(service);
    var resale = isResale(service);

    var dressCell = '<td class="ord-na">—</td>';
    if (!resale) {
      var dressOpts = ['<option value="">Choose a dress</option>'];
      ['Gents', 'Ladies', 'Other'].forEach(function (cat) {
        if (!groups[cat].length) return;
        dressOpts.push('<optgroup label="' + esc(cat) + '">');
        groups[cat].forEach(function (name) {
          dressOpts.push('<option value="' + esc(name) + '"' + (name === it.dress_type ? ' selected' : '') + '>' + esc(name) + '</option>');
        });
        dressOpts.push('</optgroup>');
      });

      // A chosen measurement already names the garment, so the box is shown
      // filled in rather than asking the tailor to repeat themselves.
      dressCell = '<td>' + (it.measurement_id
        ? '<span class="ord-fixed">' + esc(it.dress_type || 'From measurement') + '</span>'
        : '<select class="ui-input" data-ord-item="' + i + '" data-f="dress_type"' + roAttr() + '>' + dressOpts.join('') + '</select>') +
        '</td>';
    }

    var liningCell = '<td class="ord-na">—</td>';
    if (tailoring) {
      liningCell = '<td><select class="ui-input" data-ord-item="' + i + '" data-f="lining"' + roAttr() + '>' +
        LINING_OPTIONS.map(function (l) {
          return '<option value="' + esc(l) + '"' + (l === (it.lining || '') ? ' selected' : '') + '>' +
            (l === '' ? 'None' : esc(l)) + '</option>';
        }).join('') +
        '</select></td>';
    }

    var resaleCell = '<td class="ord-na">—</td>';
    if (resale) {
      var stock = availableResale();
      var rOpts = ['<option value="">Choose a stock item</option>'];
      stock.forEach(function (r) {
        rOpts.push('<option value="' + esc(r.item) + '"' + (r.item === it.resale_item ? ' selected' : '') + '>' +
          esc(r.item) + ' — ' + money(r.sell_price) + ' (' + r.qty + ' left)</option>');
      });

      // An order already on screen may name a garment that has since sold out.
      // It has to stay in the list, or the select would show the blank first
      // option and saving would fail on an order the tailor is only trying to
      // correct. Offered, but marked so it is obvious nothing is left.
      var chosen = it.resale_item;
      if (chosen && !stock.some(function (r) { return r.item === chosen; })) {
        var sold = state.resale.filter(function (r) { return r.item === chosen; })[0];
        rOpts.push('<option value="' + esc(chosen) + '" selected>' +
          esc(chosen) + ' — ' + money(sold ? sold.sell_price : 0) + ' (none left)</option>');
        stock = stock.concat([{ item: chosen, qty: 0, sell_price: sold ? num(sold.sell_price) : 0 }]);
      }

      resaleCell = '<td>' + (stock.length
        ? '<select class="ui-input" data-ord-item="' + i + '" data-f="resale_item"' + roAttr() + '>' + rOpts.join('') + '</select>'
        : '<span class="ord-fixed">No stock yet</span>') + '</td>';
    }

    var mCell = '<td class="ord-na">—</td>';
    if (tailoring) {
      var mOpts = ['<option value="">None</option>'];
      state.measurements.forEach(function (m) {
        var label = m.code + ' · ' + m.dress_type + ' · ' + dateLabel(m.created_at);
        mOpts.push('<option value="' + esc(m.id) + '"' + (m.id === it.measurement_id ? ' selected' : '') + '>' + esc(label) + '</option>');
      });
      mCell = '<td>' + (state.measurements.length
        ? '<select class="ui-input" data-ord-item="' + i + '" data-f="measurement_id"' + roAttr() + '>' + mOpts.join('') + '</select>'
        : '<span class="ord-fixed">No measurements</span>') +
        (!state.readonly && state.formCustomer && state.formCustomer.id
          ? '<button type="button" class="btn btn-sm btn-quiet ord-measure-btn" data-ord-measure="' + i + '">+ Add</button>'
          : '') +
        '</td>';
    }

    // The item's own progress sits next to its promise date, so one order can
    // carry a finished shirt and a shirt still at the bench without confusion.
    var sCell = state.readonly
      ? '<td>' + itemStatusChip(itemStatus(it)) + '</td>'
      : '<td><select class="ui-input" data-ord-item="' + i + '" data-f="status">' +
          ITEM_FLOW.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === itemStatus(it) ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select></td>';

    return '<tr>' +
      '<td><select class="ui-input" data-ord-item="' + i + '" data-f="service"' + roAttr() + '>' +
          SERVICES.map(function (s) {
            return '<option value="' + esc(s) + '"' + (s === service ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') +
        '</select></td>' +
      dressCell + liningCell + resaleCell +
      '<td class="num"><input class="ui-input" data-ord-item="' + i + '" data-f="qty" inputmode="decimal" value="' + esc(it.qty) + '"' + roAttr() + '></td>' +
      // A resale rate comes from the stock item, so it is locked rather than
      // editable, or the sell price would be quietly overwritten. For services
      // with a configured starting price, the rate cannot go below that floor.
      (function () {
        var floor = resale ? 0 : startingPriceFor(service, it.dress_type, it.lining);
        var title = resale
          ? 'Rate comes from the stock item'
          : (floor > 0 ? 'Starting price is ' + money(floor) : '');
        return '<td class="num">' + (resale
          ? '<input class="ui-input" data-ord-item="' + i + '" data-f="rate" inputmode="decimal" value="' + esc(it.rate) + '" readonly title="' + esc(title) + '">'
          : '<input class="ui-input" data-ord-item="' + i + '" data-f="rate" inputmode="decimal" value="' + esc(it.rate) + '"' +
              (title ? ' title="' + esc(title) + '"' : '') + roAttr() + '>') + '</td>';
      })() +
      '<td class="num"><input class="ui-input" data-ord-item="' + i + '" data-f="extra" inputmode="decimal" value="' + esc(it.extra) + '"' + roAttr() + '></td>' +
      '<td class="num ord-line-total"><strong>' + money(lineTotal(it)) + '</strong></td>' +
      '<td><input class="ui-input" data-ord-item="' + i + '" data-f="delivery_date" type="date" value="' + esc(it.delivery_date || '') + '"' + roAttr() + '></td>' +
      sCell +
      mCell +
      (state.readonly
        ? '<td></td>'
        : '<td><button class="btn btn-sm btn-danger" data-ord-rm="' + i + '" title="Remove item">&times;</button></td>') +
    '</tr>';
  }

  /* The money summary on an order. Each figure carries its own data-total key so
   * adding a GST line cannot quietly shift the values written by refreshTotals. */
  function totalsRows(t) {
    var tax = gstForForm(t.discount);
    var net = round2(t.total - t.discount);

    return '<div class="ord-totals">' +
      '<div class="ord-total" data-total="total"><span>Total (incl. GST)</span>' +
        '<strong>' + money(t.total) + '</strong></div>' +
      '<div class="ord-total" data-total="discount"><span>Discount</span>' +
        '<strong>- ' + money(t.discount) + '</strong></div>' +
      (tax
        ? '<div class="ord-total ord-total-gst" data-total="taxable"><span>Taxable amount</span>' +
            '<strong>' + money(tax.taxable) + '</strong></div>' +
          (tax.lines || []).map(function (l, i) {
            var label = window.ANT.bills && typeof window.ANT.bills.taxLineLabel === 'function'
              ? window.ANT.bills.taxLineLabel(l)
              : (l.label + ' ' + num(l.rate) + '%');
            return '<div class="ord-total ord-total-gst" data-total="gst-line-' + i + '">' +
              '<span>GST included: ' + esc(label) + '</span>' +
              '<strong>' + money(l.tax) + '</strong></div>';
          }).join('') +
          '<div class="ord-total ord-total-gst" data-total="gst">' +
            '<span>GST included (' + (tax.state === 'TN' ? 'CGST + SGST' : 'IGST') + ')</span>' +
            '<strong>' + money(tax.total) + '</strong></div>' +
          (tax.state === 'TN'
            ? '<div class="ord-total ord-total-gst" data-total="cgst">' +
                '<span>CGST included</span><strong>' + money(tax.cgst) + '</strong></div>' +
              '<div class="ord-total ord-total-gst" data-total="sgst">' +
                '<span>SGST included</span><strong>' + money(tax.sgst) + '</strong></div>'
            : '<div class="ord-total ord-total-gst" data-total="igst">' +
                '<span>IGST included</span><strong>' + money(tax.igst) + '</strong></div>')
        : '') +
      '<div class="ord-total ord-total-net" data-total="net"><span>Payable (incl. GST)</span>' +
        '<strong>' + money(net) + '</strong></div>' +
      '<div class="ord-total" data-total="advance"><span>Advance</span>' +
        '<strong>- ' + money(t.advance) + '</strong></div>' +
      '<div class="ord-total ord-total-balance" data-total="balance">' +
        '<span>Balance due</span><strong>' + money(t.balance) + '</strong></div>' +
    '</div>';
  }

  function totalsCard(order, t) {
    var editing = state.form !== 'new';

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">Order details</h2>' +
      '<div class="form-grid">' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="ordDate">Order date</label>' +
          '<input class="ui-input" id="ordDate" type="date" value="' + esc(editing ? order.order_date : today()) + '"' + roAttr() + '>' +
        '</div>' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="ordDiscount">Discount (whole order)</label>' +
          '<input class="ui-input" id="ordDiscount" inputmode="decimal" value="' +
            esc(editing ? num(order.discount) : 0) + '"' + roAttr() + '>' +
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
          '<textarea class="ui-textarea" id="ordNotes" placeholder="Fabric, style, anything the cutter should know"' + roAttr() + '>' +
            esc(editing ? order.notes : '') +
          '</textarea>' +
        '</div>' +
      '</div>' +
      totalsRows(t) +
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
      lining: '',
      resale_item: '',
      qty: 1,
      rate: 0,
      extra: 0,
      delivery_date: '',
      status: 'Pending',
      measurement_id: ''
    };
  }

  // Changing the service rebuilds the row, so anything the new service cannot
  // use is cleared. The legacy system also resets the rate and extra charge
  // here, because a price agreed for a different service is meaningless: a rate
  // typed for a Shirt must not silently carry over to Ironing.
  function applyServiceToItem(item, service) {
    item.service = service;
    item.rate = 0;
    item.extra = 0;

    if (!isTailoring(service)) {
      item.lining = '';
    }

    if (isResale(service)) {
      // A resale order is a stock item, not a garment being cut, so the
      // measurement that says "cut from this" does not apply.
      item.measurement_id = '';
      item.dress_type = '';
      item.category = '';
      item.lining = '';
    }

    if (!isResale(service)) {
      item.resale_item = '';
    }

    if (isResale(service) && item.resale_item) {
      var found = resaleById(item.resale_item);
      if (found) item.rate = num(found.sell_price);
    }

    // For services whose price portal entry is a starting price, prefill the
    // floor so the tailor sees the minimum and cannot accidentally save below it.
    if (!isResale(service)) {
      var floor = startingPriceFor(service, item.dress_type, item.lining);
      if (floor > 0) item.rate = floor;
    }

    return item;
  }

  // Selecting a measurement tells the tailor what is being cut, so the garment
  // follows from it rather than being asked for twice. This is the legacy
  // applyMeasurementToItem behaviour.
  function applyMeasurementToItem(item, measurementId) {
    item.measurement_id = measurementId || '';

    if (!measurementId) {
      // No measurement chosen: let the tailor pick the garment by hand.
      return item;
    }

    var m = state.measurements.filter(function (x) { return x.id === measurementId; })[0];
    if (m) {
      item.dress_type = m.dress_type;
      var groups = groupedDressTypes();
      item.category = groups.Gents.indexOf(m.dress_type) !== -1 ? 'Gents'
        : (groups.Ladies.indexOf(m.dress_type) !== -1 ? 'Ladies' : 'Other');
    }
    return item;
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
      if (!it.service) return 'Choose a service for item ' + n + '.';
      if (num(it.qty) <= 0) return 'Quantity must be more than zero for item ' + n + '.';
      if (num(it.rate) < 0) return 'Rate cannot be negative for item ' + n + '.';
      var floor = startingPriceFor(it.service, it.dress_type, it.lining);
      if (floor > 0 && num(it.rate) < floor) {
        return 'Starting price is ' + money(floor) + ' for item ' + n + '.';
      }
      if (num(it.extra) < 0) return 'Extra charge cannot be negative for item ' + n + '.';
      if (!it.delivery_date) return 'Give a delivery date for item ' + n + '.';
      if (ITEM_FLOW.indexOf(it.status) === -1) {
        return 'Choose a status for item ' + n + '.';
      }

      if (isResale(it.service)) {
        if (!it.resale_item) return 'Choose the stock item being sold on item ' + n + '.';
      } else if (!it.dress_type) {
        // The dress box is on screen for everything except a resale, so it is
        // required for everything except a resale. Lining stays optional: it is
        // a Tailoring extra, not part of every job.
        return 'Choose a dress for item ' + n + '.';
      }
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

  function resaleIdByName(name) {
    if (!name) return null;
    var hit = state.resale.filter(function (r) { return r.item === name; })[0];
    return hit ? hit.id : null;
  }

  function itemPayload(it, orderId, lineNo) {
    var dress = it.dress_type;
    var groups = groupedDressTypes();
    var category = 'Gents';
    if (groups.Ladies.indexOf(dress) !== -1) category = 'Ladies';
    else if (groups.Gents.indexOf(dress) === -1) category = dress ? 'Other' : '';

    // The legacy sheet kept the resale item's name in the variant column,
    // because there was no separate field. The new schema has a real
    // resale_item_id foreign key, so the name is resolved to a row here and the
    // name is still written to variant so an export of old data lines up.
    var resaleId = null;
    if (isResale(it.service)) {
      resaleId = resaleIdByName(it.resale_item);
    }

    var row = {
      order_id: orderId,
      line_no: lineNo,
      category: category,
      dress_type: dress,
      service: it.service,
      variant: isResale(it.service) ? (it.resale_item || '') : '',
      lining: isTailoring(it.service) ? (it.lining || '') : '',
      resale_item_id: resaleId,
      quantity: num(it.qty),
      rate: num(it.rate),
      discount: 0,
      extra_charge: num(it.extra),
      line_total: lineTotal(it),
      delivery_date: it.delivery_date,
      status: itemStatus(it),
      measurement_id: isTailoring(it.service) && it.measurement_id ? it.measurement_id : null,
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
          // The orders_read policy hides archived orders from staff, so the
          // highest number the reader can see may already be in use. A unique
          // violation steps to the next number rather than failing on a key the
          // tailor cannot act on.
          var attempt = function (ordCode, tries) {
            head.code = ordCode;
            return sb().from('orders')
              .insert(head)
              .single()
              .then(function (res) {
                if (res.error || !res.data) {
                  if (tries < 50 && isDuplicateCode(res)) {
                    var s = serialFromCode(ordCode);
                    if (s != null) return attempt(codeFor(s + 1), tries + 1);
                  }
                  return { error: res.error || { message: 'The order could not be saved.' } };
                }
                orderId = res.data.id;
                return replaceItems(orderId);
              });
          };
          return attempt(code, 0);
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
        if (editing) refreshBillsForOrder(orderId);
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

  function refreshBillsForOrder(orderId) {
    try {
      var bills = window.ANT && window.ANT.bills;
      if (bills && bills.refreshForOrder) {
        return Promise.resolve(bills.refreshForOrder(orderId)).catch(function () {});
      }
    } catch (e) {}
    return Promise.resolve();
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

  // Codes read AN-ORD-<YY>-<NNNN>: brand, type, two-digit year, running serial.
  // The serial is drawn from the database counter (next_code), which never
  // hands the same number out twice and resets each year.
  var TYPE = 'ORD';

  function yearTag() {
    return String(new Date().getFullYear() % 100).padStart(2, '0');
  }

  function codeFor(n) {
    return 'AN-' + TYPE + '-' + yearTag() + '-' + String(n).padStart(4, '0');
  }

  function serialFromCode(code) {
    var m = /(\d+)\s*$/.exec(code || '');
    return m ? parseInt(m[1], 10) : null;
  }

  // The orders_read policy hides archived orders from staff, so the highest
  // code on the shelf can already be taken by a row that never appears in this
  // result. This maximum is therefore only a starting point.
  function highestSerial() {
    return sb().from('orders')
      .select('code')
      .ilike('code', 'AN-' + TYPE + '-' + yearTag() + '-*')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        if (res.error) return null;
        var n = 1;
        if (res.data && res.data.length) {
          var s = serialFromCode(res.data[0].code);
          if (s != null) n = s + 1;
        }
        return n;
      });
  }

  // Prefer the counter. Fall back to the highest visible serial when the RPC
  // is not present - an older database, or a test double with no rpc().
  function nextCode(serial) {
    if (serial != null) return Promise.resolve(codeFor(serial));
    var client = sb();
    if (client && typeof client.rpc === 'function') {
      return client.rpc('next_code', { p_type: TYPE }).then(function (res) {
        if (res && !res.error && typeof res.data === 'string' && res.data) {
          return res.data;
        }
        return highestSerial().then(function (n) { return n == null ? null : codeFor(n); });
      });
    }
    return highestSerial().then(function (n) { return n == null ? null : codeFor(n); });
  }

  // A 409 from PostgREST is a unique violation (Postgres 23505). The message is
  // checked as well so the retry keeps working if the status is ever dropped.
  function isDuplicateCode(res) {
    if (!res || !res.error) return false;
    if (res.error.status === 409) return true;
    var m = String(res.error.message || '').toLowerCase();
    return m.indexOf('duplicate') > -1 || m.indexOf('unique') > -1;
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
            // Only the owner may change a saved order; everyone else gets it
            // read only. Status and Tell customer stay available on the list.
            state.readonly = !isOwner();

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
                lining: it.lining || '',
                // A resale line keeps the item name in variant and the stock
                // row's key in resale_item_id. The box offers names, so the name
                // is what has to be put back, or the line would come up with
                // nothing selected and saving it again would write the key into
                // the name column.
                resale_item: it.variant || it.resale_item_id || '',
                qty: it.quantity,
                rate: it.rate,
                extra: it.extra_charge,
                delivery_date: it.delivery_date || '',
                status: itemStatus(it),
                measurement_id: it.measurement_id || ''
              };
            });
            if (!state.formItems.length) state.formItems = [blankItem()];

            state.formCustomer = order.customer || null;
            state.view = 'edit';
            return Promise.all([loadReference(), loadResale(), loadPrices()])
              .then(function () { return loadMeasurements(order.customer_id); })
              .then(paint);
          });
      });
  }

  // Opens a fresh order, optionally already assigned to a customer. The plain
  // + New order button passes nothing; the Customers screen quick action passes
  // the row it just saved, so the same person is not picked twice.
  function openNewForCustomer(c) {
    var chosen = c || null;
    state.form = 'new';
    state.readonly = false;
    state.formItems = [blankItem()];
    state.formCustomer = chosen;
    state.customerQuery = chosen ? (chosen.name || '') : '';
    state.customers = [];
    state.measurements = [];
    state.resale = [];
    state.lastDelivery = '';
    state.quickCustomerForm = false;
    state.view = 'edit';
    var work = Promise.all([loadReference(), loadResale(), loadPrices()]);
    if (chosen && chosen.id) work = work.then(function () { return loadMeasurements(chosen.id); });
    return work.then(paint);
  }

  function startNew() {
    return openNewForCustomer(null);
  }

  // Creates a walk-in from inside the order form, then selects them on it.
  function createInlineCustomer() {
    if (!window.ANT.customers || typeof window.ANT.customers.createQuick !== 'function') {
      return toast('The customer form is not ready. Try again.', 'error');
    }

    var nameEl = byId('ordQCName');
    var mobileEl = byId('ordQCMobile');
    var addressEl = byId('ordQCAddress');
    var name = nameEl ? nameEl.value.trim() : '';
    var mobile = mobileEl ? mobileEl.value.trim() : '';
    var address = addressEl ? addressEl.value.trim() : '';

    if (!name) {
      toast('Enter a name', 'error');
      if (nameEl) nameEl.focus();
      return;
    }
    if (!mobile) {
      toast('Enter a mobile number', 'error');
      if (mobileEl) mobileEl.focus();
      return;
    }

    var btn = byId('ordQCSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    return window.ANT.customers.createQuick({
      name: name, mobile: mobile, address: address, notes: ''
    }).then(function (res) {
      var row = res && res.data;
      if ((res && res.error) || !row || !row.id) {
        if (btn) { btn.disabled = false; btn.textContent = 'Save customer'; }
        return toast((res && res.error && res.error.message) || 'Customer could not be saved.', 'error');
      }
      state.formCustomer = row;
      state.customerQuery = row.name || name;
      state.customers = [];
      state.quickCustomerForm = false;
      toast('Customer added', 'success');
      return loadMeasurements(row.id).then(paint);
    });
  }

  // Only an id was carried from another screen, so read the row here.
  function loadCustomerById(id) {
    return sb().from('customers')
      .select('id,code,name,mobile,address')
      .eq('id', id)
      .limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return null;
        return res.data[0];
      });
  }

  /* The Measurements page saved a row for this order. Remember its id, then
   * let the normal route change bring the tailor back here. */
  function resumeFromMeasurement(measurementId) {
    pendingMeasurement = measurementId || null;
    var here = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (here === 'orders') return render();
    location.hash = '#/orders';
    return Promise.resolve();
  }

  /* Put the unsaved order back exactly as it was, with the new measurement
   * selected on the row it was asked from. Nothing here writes to the database:
   * the tailor still presses Save order when the order is complete. */
  function restoreDraft(measurementId) {
    var draft = null;
    try { draft = JSON.parse(sessionStorage.getItem('an-tailor-order-draft') || 'null'); } catch (e) {}
    try { sessionStorage.removeItem('an-tailor-order-draft'); } catch (e) {}

    if (!draft) return Promise.resolve();

    state.form = draft.form || 'new';
    state.readonly = !!draft.readonly;
    state.formItems = (Array.isArray(draft.formItems) && draft.formItems.length)
      ? draft.formItems : [blankItem()];
    state.formCustomer = draft.formCustomer || null;
    state.customerQuery = draft.customerQuery || '';
    state.lastDelivery = draft.lastDelivery || '';
    state.quickCustomerForm = false;
    state.view = 'edit';
    state.error = null;
    state.saveError = '';

    var idx = typeof draft.itemIndex === 'number' ? draft.itemIndex : 0;
    if (measurementId && state.formItems[idx]) {
      applyMeasurementToItem(state.formItems[idx], measurementId);
      var floor = startingPriceFor(
        state.formItems[idx].service, state.formItems[idx].dress_type, state.formItems[idx].lining
      );
      if (floor > 0 && num(state.formItems[idx].rate) < floor) state.formItems[idx].rate = floor;
    }

    var work = Promise.all([loadReference(), loadResale(), loadPrices()]);
    if (state.formCustomer && state.formCustomer.id) {
      work = work.then(function () { return loadMeasurements(state.formCustomer.id); });
    }
    return work.then(function () {
      paint();
      toast(measurementId ? 'Measurement saved and added to the order.' : 'Order restored.', 'success');
    });
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

  /* Deletes an order, its items, and every bill linked to it. Owner only: both
   * the orders and bills RLS policies are owner-only, and the button is hidden
   * from staff as well. The linked bills go first; if any one of them fails the
   * order is left alone, because an orphaned or half-billed order is worse than
   * a delete that simply did not happen. */
  function removeOrder(orderId) {
    if (!isOwner()) {
      toast('Only the Owner can delete an order.', 'error');
      return Promise.resolve();
    }

    // An id is passed by the list's row button; the edit form has no id argument
    // and falls back to the order open on screen.
    var order = orderId
      ? (state.orders.filter(function (o) { return o.id === orderId; })[0] || null)
      : state.form;
    if (!order) {
      toast('That order is not on this page.', 'error');
      return Promise.resolve();
    }

    if (!window.confirm('Delete order ' + order.code + ', its items, and any bill linked to it?\n\n' +
      'This cannot be undone.')) return Promise.resolve();

    var billsApi = window.ANT.bills;
    var clearBills = (billsApi && typeof billsApi.deleteForOrder === 'function')
      ? billsApi.deleteForOrder(order.id)
      : Promise.resolve({ ok: true, count: 0 });

    return Promise.resolve(clearBills).then(function (cleared) {
      if (cleared && cleared.error) {
        toast(cleared.error, 'error');
        return null;
      }

      return sb().from('orders')
        .delete()
        .eq('id', order.id)
        .select('id')
        .then(function (res) {
          if (res.error) return toast(res.error.message, 'error');
          if (!res.data || res.data.length === 0) {
            return toast('That order could not be deleted. Only the Owner can remove an order.', 'error');
          }
          var freed = (cleared && cleared.count)
            ? ' The linked bill was deleted too.'
            : '';
          toast('Order deleted.' + freed, 'success');
          state.view = 'list';
          state.form = null;
          state.formItems = [];
          state.formCustomer = null;
          state.measurements = [];
          return loadOrders();
        });
    }).catch(function (e) {
      toast('The order could not be deleted: ' +
        ((e && e.message) || 'the request failed.'), 'error');
      return null;
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

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-tell]'), function (btn) {
      btn.addEventListener('click', function () {
        tellReady(btn.getAttribute('data-ord-tell'));
      });
    });

    // From the order straight to its money. The target screens already hold the
    // rules, so these buttons only hand the order over and let them load it.
    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-pay]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ord-pay');
        if (window.ANT.payments && typeof window.ANT.payments.focusOrder === 'function') {
          window.ANT.payments.focusOrder(id);
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-bill]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ord-bill');
        if (window.ANT.bills && typeof window.ANT.bills.focusOrder === 'function') {
          window.ANT.bills.focusOrder(id);
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.ord-set'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ord-id');
        var next = btn.getAttribute('data-next');
        var cur = btn.getAttribute('data-cur');
        btn.disabled = true;
        applyStatus(id, next, cur, function () { paint(); }, function () { btn.disabled = false; });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.item-set'), function (btn) {
      btn.addEventListener('click', function () {
        var orderId = btn.getAttribute('data-item-ord');
        var itemId = btn.getAttribute('data-item-id');
        var next = btn.getAttribute('data-item-next');
        var cur = btn.getAttribute('data-item-cur');
        btn.disabled = true;
        applyItemStatus(orderId, itemId, next, cur, function () { paint(); }, function () {
          btn.disabled = false;
        });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-del]'), function (btn) {
      btn.addEventListener('click', function () {
        removeOrder(btn.getAttribute('data-ord-del'));
      });
    });
  }

  function wireEdit() {
    var back = byId('ordBack');
    if (back) back.addEventListener('click', closeEdit);

    var cancel = byId('ordCancel');
    if (cancel) cancel.addEventListener('click', closeEdit);

    var del = byId('ordDelete');
    // Wrapped so the click event is not mistaken for an order id. The row
    // button passes its id explicitly; the form button works from state.form.
    if (del) del.addEventListener('click', function () { removeOrder(); });

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

    var newCust = byId('ordNewCust');
    if (newCust) {
      newCust.addEventListener('click', function () {
        state.quickCustomerForm = true;
        paint();
        var field = byId('ordQCName');
        if (field) field.focus();
      });
    }

    var qcCancel = byId('ordQCCancel');
    if (qcCancel) {
      qcCancel.addEventListener('click', function () {
        state.quickCustomerForm = false;
        paint();
      });
    }

    var qcForm = byId('ordQCSave');
    if (qcForm) qcForm.addEventListener('click', createInlineCustomer);

    // Add a measurement for this customer without losing the rows already
    // typed on this order. The draft is put back when the measurement is saved.
    Array.prototype.forEach.call(document.querySelectorAll('[data-ord-measure]'), function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-ord-measure'), 10);
        if (isNaN(i) || !state.formItems[i]) return;
        if (!state.formCustomer || !state.formCustomer.id) {
          return toast('Choose a customer first.', 'error');
        }
        readItems();
        try {
          sessionStorage.setItem('an-tailor-order-draft', JSON.stringify({
            form: state.form,
            formItems: state.formItems,
            formCustomer: state.formCustomer,
            customerQuery: state.customerQuery,
            readonly: state.readonly,
            lastDelivery: state.lastDelivery,
            itemIndex: i,
            dressType: state.formItems[i].dress_type || ''
          }));
        } catch (e) {}

        if (window.ANT.measurements && typeof window.ANT.measurements.focusCustomer === 'function') {
          window.ANT.measurements.focusCustomer(state.formCustomer, {
            returnToOrder: true,
            dressType: state.formItems[i].dress_type || ''
          });
        } else {
          location.hash = '#/measurements';
        }
      });
    });

    var applyDateAll = byId('ordApplyDateAll');
    if (applyDateAll) {
      applyDateAll.addEventListener('click', function () {
        var picker = byId('ordApplyDate');
        var date = picker ? picker.value : '';
        if (!date) return toast('Choose a delivery date first.', 'error');
        readItems();
        state.formItems.forEach(function (it) { it.delivery_date = date; });
        state.lastDelivery = date;
        paint();
        toast('Delivery date applied to all ' + state.formItems.length + ' items.', 'success');
      });
    }

    var addItem = byId('ordAddItem');
    if (addItem) {
      addItem.addEventListener('click', function () {
        readItems();
        if (state.formItems.length >= MAX_ITEMS) {
          return toast('An order cannot contain more than ' + MAX_ITEMS + ' items.', 'error');
        }
        var row = blankItem();
        // Orders usually share one delivery date, so a new row starts with the
        // date already used rather than asking for it again.
        var dated = state.formItems.filter(function (x) { return x.delivery_date; });
        row.delivery_date = state.lastDelivery || (dated.length ? dated[dated.length - 1].delivery_date : '');
        state.formItems.push(row);
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
        var i = parseInt(el.getAttribute('data-ord-item'), 10);
        var f = el.getAttribute('data-f');
        if (isNaN(i) || !state.formItems[i]) return;

        if (f === 'service') {
          // Switching service changes which columns exist, so the row has to be
          // rebuilt. The rate is reset the way the legacy editor did, because
          // a price agreed for one service means nothing for another.
          readItems();
          applyServiceToItem(state.formItems[i], el.value);
          paint();
          return;
        }

        if (f === 'measurement_id') {
          readItems();
          applyMeasurementToItem(state.formItems[i], el.value);
          var mFloor = startingPriceFor(state.formItems[i].service, state.formItems[i].dress_type, state.formItems[i].lining);
          if (mFloor > 0 && num(state.formItems[i].rate) < mFloor) {
            state.formItems[i].rate = mFloor;
          }
          paint();
          return;
        }

        if (f === 'resale_item') {
          readItems();
          state.formItems[i].resale_item = el.value;
          var stock = availableResale().filter(function (r) { return r.item === el.value; })[0];
          if (stock) state.formItems[i].rate = num(stock.sell_price);
          paint();
          return;
        }

        readItems();
        if (f === 'delivery_date') state.lastDelivery = state.formItems[i].delivery_date || '';
        var floor = startingPriceFor(state.formItems[i].service, state.formItems[i].dress_type, state.formItems[i].lining);
        var rateEl = document.querySelector('[data-ord-item="' + i + '"][data-f="rate"]');
        if ((f === 'dress_type' || f === 'lining') && floor > 0 && num(state.formItems[i].rate) < floor) {
          state.formItems[i].rate = floor;
          if (rateEl && !rateEl.readOnly) rateEl.value = String(floor);
          refreshLineTotal(i);
        }
        if (rateEl && !rateEl.readOnly) {
          rateEl.title = floor > 0 ? 'Starting price is ' + money(floor) : '';
        }
        refreshTotals();
        if (f === 'rate' && floor > 0 && num(state.formItems[i].rate) < floor) {
          toast('Starting price is ' + money(floor) + ' for item ' + (i + 1) + '.', 'error');
        }
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
    // Columns: Service, Dress, Lining, Resale item, Qty, Rate, Extra, Total.
    // index() is used rather than a fixed number so a future column change
    // cannot silently write the total into the wrong cell.
    var cell = row.querySelector('td.ord-line-total');
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

    function put(key, value) {
      var el = box.querySelector('[data-total="' + key + '"] strong');
      if (el) el.textContent = value;
    }

    put('total', money(t.total));
    put('discount', '- ' + money(t.discount));
    put('net', money(round2(t.total - t.discount)));
    put('advance', '- ' + money(t.advance));
    put('balance', money(t.balance));

    var tax = gstForForm(t.discount);
    if (!tax) return;
    put('taxable', money(tax.taxable));
    put('gst', money(tax.total));
    if (tax.state === 'TN') {
      put('cgst', money(tax.cgst));
      put('sgst', money(tax.sgst));
    } else {
      put('igst', money(tax.igst));
    }
    (tax.lines || []).forEach(function (l, i) {
      put('gst-line-' + i, money(l.tax));
    });
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

  var api = {
    mount: function () {
      return '<div id="ordersView"></div>';
    },

    render: function () {
      // A customer handed over by the Customers screen is consumed here, after
      // the normal reset, so it cannot be wiped by it.
      var pending = state.pendingCustomer;
      var pendingId = state.pendingCustomerId;
      state.pendingCustomer = null;
      state.pendingCustomerId = null;

      var measure = pendingMeasurement;
      pendingMeasurement = null;
      // A draft left behind by a cancelled measurement detour is not wanted.
      if (!measure) { try { sessionStorage.removeItem('an-tailor-order-draft'); } catch (e) {} }

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
      state.resale = [];
      state.lastDelivery = '';
      state.quickCustomerForm = false;
      state.waShop = { name: '', waReadyMessage: '', upiId: '', payee: '' };
      paint();
      return Promise.all([loadReference(), loadResale(), loadPrices()])
        .then(loadWaShop)
        .then(function () { return loadOrders(); })
        .then(function () {
          if (measure) return restoreDraft(measure);
          if (pending) return openNewForCustomer(pending);
          if (pendingId) {
            return loadCustomerById(pendingId).then(function (c) {
              if (c) return openNewForCustomer(c);
            });
          }
        });
    },

    // A Customers row action calls this. The person is remembered and the usual
    // route change renders the page, so the order form opens already assigned.
    startForCustomer: function (c) {
      var id = (typeof c === 'string') ? c : (c && c.id);
      state.pendingCustomer = (typeof c === 'string') ? null : c;
      state.pendingCustomerId = id || null;
      var here = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
      if (here === 'orders') return render();
      location.hash = '#/orders';
      return Promise.resolve();
    },

    // The Measurements page calls this after saving a row opened from an item.
    resumeFromMeasurement: resumeFromMeasurement,

    // Lets another screen advance an order along the same straight line the
    // Orders page uses. The bench on the dashboard calls this so a status tap
    // there means exactly what it means on the list.
    applyStatus: applyStatus,

    // A garment can move on its own without moving the order or sending the
    // whole-order message. Kept next to applyStatus so both workflows stay
    // visible to whoever wires another screen later.
    applyItemStatus: applyItemStatus,

    // The tap-to-pay line's appender, exposed so the harness can check it with a
    // shop address of its own - a file:// test page has none to build a link from.
    __withPayBlock: withPayBlock,

    // Exposed so the inclusive GST shown on the order can be checked without
    // waiting for a Supabase read or saving an order.
    __gstForForm: gstForForm,
    __totalsRows: totalsRows
  };

  function announceStatusChange(order, wasAuto, before, after) {
    if (!order || !after) return;
    try {
      if (typeof window.notifyOrderStatus === 'function') {
        window.notifyOrderStatus(order, after, before || order.status, wasAuto);
      }
    } catch (e) {}
  }

  /* The message a customer is waiting for when their order reaches Finish or
   * Delivery. It is the same wording the "Tell customer" button sends, built
   * from the order record itself so it can never disagree with the shop's own
   * figures.
   *
   * It is opened from the tap that changed the status, but the bill link is
   * looked up first - and the PDF drawn if it was never shared - so the message
   * can carry it. That lookup is a round trip, so the chat opens a beat after
   * the tap rather than instantly; the caller does not depend on the return
   * value, so a phone that refuses the late open still saves the status.
   *
   * Returns true when there is a status worth messaging and a usable mobile to
   * send to, false otherwise. */
  function sendStatusWhatsApp(order, status) {
    if (!order || !window.ANT.whatsapp) return false;
    if (status !== 'Finish' && status !== 'Delivery') return false;

    var customer = order.customer || {};
    if (!window.ANT.whatsapp.canSend(customer.mobile)) return false;

    var shop = state.waShop || {};

    var open = function (billLink) {
      var message = status === 'Finish'
        ? window.ANT.whatsapp.readyMessage({ shop: shop, customer: customer, order: order, billLink: billLink || '' })
        : window.ANT.whatsapp.deliveredMessage({ shop: shop, customer: customer, order: order, billLink: billLink || '' });
      message = withPayBlock(message, shop, order);
      message = withBillLink(message, billLink);

      var url = window.ANT.whatsapp.link(customer.mobile, message);
      if (url) openChat(url);
      return !!url;
    };

    // With no bill reader in this build, behave exactly as before: open at once,
    // with a message that carries no link.
    if (!window.ANT.bills || typeof window.ANT.bills.orderBillLink !== 'function') {
      return open('');
    }

    orderBillLink(order.id).then(open);
    return true;
  }

  function updateStatus(orderId, newStatus, beforeStatus, orderObj) {
    if (!orderId || !newStatus) return Promise.reject(new Error('Missing'));
    var order = orderObj || state.orders.find(function (o) { return o.id === orderId; });
    var before = beforeStatus || (order ? order.status : null);
    if (order) order.status = newStatus;
    return sb().from('orders').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', orderId).then(function (res) {
      if (res.error) throw res.error;
      try { if (typeof audit === 'function') audit('order.status', 'orders', orderId, { from: before, to: newStatus }); } catch (e) {}
      try { announceStatusChange(order, true, before, newStatus); } catch (e) {}
      return res;
    }).catch(function (err) {
      if (order) order.status = before;
      throw err;
    });
  }

  // The workflow is a straight line: Pending -> Process -> Finish -> Delivery.
  // The list shows the current status and only the steps still ahead of it, so
  // there is nothing to choose wrongly and nothing to scroll through.
  function renderStatusCell(o) {
    if (!o || !o.id) return statusChip(o.status);
    var flow = ['Pending', 'Process', 'Finish', 'Delivery'];
    var at = flow.indexOf(o.status);
    var ahead = at >= 0 ? flow.slice(at + 1) : [];
    var buttons = ahead.map(function (st) {
      var cls = st === 'Delivery' ? 'btn-success' : 'btn-secondary';
      return '<button type="button" class="btn btn-sm ' + cls + ' ord-set" data-ord-id="' + esc(o.id) + '" data-cur="' + esc(o.status) + '" data-next="' + esc(st) + '">' + esc(st) + '</button>';
    }).join('');
    if (o.status !== 'Delivery' && o.status !== 'Cancelled') {
      buttons += '<button type="button" class="btn btn-sm btn-danger ord-set" data-ord-id="' + esc(o.id) + '" data-cur="' + esc(o.status) + '" data-next="Cancelled">Cancel</button>';
    }
    // A hard delete is owner-only, in the row as well as in the edit form. The
    // RLS policy refuses staff too, but hiding the button is clearer than letting
    // them press it and be told no.
    if (isOwner()) {
      buttons += '<button type="button" class="btn btn-sm btn-danger ord-del" data-ord-del="' + esc(o.id) + '">Delete</button>';
    }
    return '<div class="ord-status-wrap">' + statusChip(o.status) +
      (buttons ? '<span class="ord-status-actions">' + buttons + '</span>' : '') + '</div>';
  }

  /* One line per garment. This is deliberately separate from the order chip:
   * a shirt can be finished while the trousers in the same order are still at
   * the bench, and neither tap may move the parent order or send its message. */
  function renderItemStatusCell(o) {
    var items = state.items[o.id] || [];
    if (!items.length) return '<span class="ord-sub">No items</span>';

    return '<div class="item-status-list">' + items.map(function (it, idx) {
      var cur = itemStatus(it);
      var at = ITEM_FLOW.indexOf(cur);
      var ahead = at >= 0 ? ITEM_FLOW.slice(at + 1) : ITEM_FLOW.slice(1);
      var buttons = it.id ? ahead.map(function (st) {
        var cls = st === 'Delivery' ? 'btn-success' : 'btn-secondary';
        return '<button type="button" class="btn btn-sm ' + cls + ' item-set"' +
          ' data-item-ord="' + esc(o.id) + '" data-item-id="' + esc(it.id) + '"' +
          ' data-item-cur="' + esc(cur) + '" data-item-next="' + esc(st) + '">' + esc(st) + '</button>';
      }).join('') : '';
      var name = it.dress_type || it.category || ('Item ' + (idx + 1));

      return '<div class="item-status-line">' +
        '<span class="ord-item-idx">' + (idx + 1) + '.</span>' +
        itemStatusChip(cur) +
        '<span class="item-status-name">' + esc(name) + '</span>' +
        (buttons ? '<span class="ord-status-actions">' + buttons + '</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function applyItemStatus(orderId, itemId, next, cur, onDone, onFail) {
    if (!orderId || !itemId || !next || next === cur) { if (onDone) onDone(); return; }
    if (ITEM_FLOW.indexOf(next) === -1) { if (onFail) onFail(); return; }

    var list = state.items[orderId] || [];
    var item = list.filter(function (it) { return it.id === itemId; })[0];
    var before = item ? itemStatus(item) : (ITEM_FLOW.indexOf(cur) !== -1 ? cur : 'Pending');
    if (item) item.status = next;

    return sb().from('order_items')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('order_id', orderId)
      .then(function (res) {
        if (res.error) throw res.error;
        try {
          if (typeof audit === 'function') {
            audit('order_item.status', 'order_items', itemId, { from: before, to: next });
          }
        } catch (e) {}
        try {
          if (typeof window.showToast === 'function') {
            window.showToast('Item status updated', { duration: 1000 });
          }
        } catch (e) {}
        if (onDone) onDone();
        return res;
      })
      .catch(function (err) {
        if (item) item.status = before;
        try {
          if (typeof window.showToast === 'function') {
            window.showToast('Update failed', { type: 'error', duration: 1500 });
          }
        } catch (e) {}
        if (onFail) onFail();
      });
  }

  function applyStatus(id, next, cur, onDone, onFail, orderObj) {
    if (!id || !next || next === cur) { if (onDone) onDone(); return; }
    if (next === 'Cancelled' && !confirm('Cancel this order?')) { if (onFail) onFail(); return; }

    var order = orderObj || state.orders.find(function (o) { return o.id === id; });

    // Finish and Delivery are the two steps whose message carries the bill, so
    // the order is put on a bill first. Without one the customer would be told
    // the work is done with no bill to look at, so the status is held back and
    // the tailor is offered the Bills page with this order already ticked.
    if (next === 'Finish' || next === 'Delivery') {
      orderOnBill(id).then(function (onBill) {
        if (onBill) { saveStatus(id, next, cur, onDone, onFail, order); return; }
        if (onFail) onFail();
        askForBill(order, id, next, cur, onDone, onFail);
      });
      return;
    }

    saveStatus(id, next, cur, onDone, onFail, order);
  }

  function saveStatus(id, next, cur, onDone, onFail, order) {
    // The chat is opened before the save so it still counts as the tap's own
    // doing; a phone blocks a chat opened on the far side of an await.
    sendStatusWhatsApp(order, next);

    updateStatus(id, next, cur, order).then(function () {
      try { if (typeof window.showToast === 'function') window.showToast('Status updated', { duration: 1000 }); } catch (e) {}
      if (onDone) onDone();
    }).catch(function (err) {
      try { if (typeof window.showToast === 'function') window.showToast('Update failed', { type: 'error', duration: 1500 }); } catch (e) {}
      if (onFail) onFail();
    });
  }

  /* Whether the order already sits on a bill, asked of the Bills page's reader.
   * A lookup that cannot be made counts as "on a bill": a check the app cannot
   * complete must never stop the tailor from updating an order. */
  function orderOnBill(orderId) {
    var bills = window.ANT && window.ANT.bills;
    if (!bills || typeof bills.orderBillId !== 'function') return Promise.resolve(true);
    return Promise.resolve(bills.orderBillId(orderId))
      .then(function (billId) { return !!billId; })
      .catch(function () { return true; });
  }

  /* The order is not on a bill. The usual path is to make that one bill right
   * here and then let the status through; if that cannot be done, the old route
   * to the Bills page stays as the fallback. */
  function askForBill(order, id, next, cur, onDone, onFail) {
    var code = (order && order.code) ? order.code : 'This order';
    var bills = window.ANT && window.ANT.bills;
    var go = window.confirm(code + ' is not on a bill yet.\n\n' +
      'A bill is needed before the ' + next + ' message can carry it.\n\n' +
      'OK = create a bill for this order now, then set ' + next + '.\n' +
      'Cancel = open the Bills page with this order selected.');

    if (!go || !bills || typeof bills.createForOrder !== 'function') {
      if (bills && typeof bills.focusOrder === 'function') bills.focusOrder(id);
      else location.hash = '#/bills';
      return;
    }

    return bills.createForOrder(id).then(function (res) {
      if (res && res.ok) {
        toast((res.message || 'Bill created.') + ' Setting ' + next + '.', 'success');
        saveStatus(id, next, cur, onDone, onFail, order);
        return;
      }
      toast((res && res.error) || 'Bill could not be created.', 'error');
      if (bills && typeof bills.focusOrder === 'function') bills.focusOrder(id);
      else location.hash = '#/bills';
    }).catch(function () {
      if (bills && typeof bills.focusOrder === 'function') bills.focusOrder(id);
      else location.hash = '#/bills';
    });
  }

  // The hand-off hooks call this when the browser is already on this page, so
  // there is no route change to trigger a render for them.
  function render() {
    return api.render();
  }

  return api;
})();

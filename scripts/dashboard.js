/* AN TAILOR - the dashboard.
 *
 * This is the first screen the shop sees, so it answers two questions and
 * nothing else: how much money is still owed, and what is waiting to be
 * finished. Before this the tiles were hardcoded zeros, which is worse than
 * no dashboard at all - a tailor looking at a confident "0 orders today" has
 * no way to tell that is a placeholder rather than the truth.
 *
 * The figures are counts and sums read straight from the tables the rest of
 * the app already writes, so a number on this screen and a number on a bill
 * can never disagree.
 *
 * What is deliberately left out:
 *
 *   - Cancelled orders are excluded everywhere. A cancelled order is work that
 *     was called off, and counting it as "in progress" or "ready" would put a
 *     job on the board that nobody is doing.
 *   - Archived rows are excluded. Archiving is how a mistake is taken out of
 *     the working set, so an archived order must stop moving the numbers.
 *   - Outstanding is money owed on live bills, not a raw sum of order
 *     balances. An order that was never billed has an order balance but no
 *     customer is being asked for it yet, and a bill is what asks.
 *
 * Money is summed here in JavaScript rather than in the database. PostgREST
 * has no aggregate over a filtered select without a view, and the alternative
 * is a view per figure that has to be kept in step with this file. A tailoring
 * shop holds hundreds of orders, not millions, so summing a few hundred
 * numbers in the browser is instant and keeps the logic in one readable place.
 */

window.ANT = window.ANT || {};

window.ANT.dashboard = (function () {
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var money = function (v) { return window.ANT.money(v); };

  function sb() {
    return window.ANT.sb;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  /* The local calendar date as YYYY-MM-DD.
   *
   * toISOString() is not usable here. It converts to UTC first, so for a shop
   * in IST an order taken at 9am on the 1st is stamped the 31st, and "orders
   * today" would be quietly wrong for every morning and evening of the day.
   */
  function isoToday() {
    var d = new Date();
    return d.getFullYear() + '-'
      + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
      + ('0' + d.getDate()).slice(-2);
  }

  /* Monday of the current week, as YYYY-MM-DD. "Delivered this week" and money
   * "collected this week" are shop figures measured from a week start, and a
   * tailor's week begins on Monday. getDay() counts Sunday as 0, so that one
   * day has to be pushed back six rather than back zero. */
  function isoWeekStart() {
    var d = new Date();
    var dow = d.getDay();
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d.getFullYear() + '-'
      + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
      + ('0' + d.getDate()).slice(-2);
  }

  var state = {
    loaded: false,
    error: '',
    /* Areas this account was not granted, so their tiles can say "not in your
     * access" instead of a number that was never asked for. Empty means the
     * person can read everything the dashboard reports. */
    held: null,
    ordersToday: 0,
    inProgress: 0,
    ready: 0,
    deliveredWeek: 0,
    outstanding: 0,
    collectedWeek: 0,
    urgent: 0,
    /* The jobs themselves, so the screen says what needs doing rather than only
     * how many. Capped: this is a glance, not a work list, and the full list
     * already exists on the Orders page. */
    bench: []
  };

  var BENCH_LIMIT = 6;

  /* A blocked or failed query must not read as zero. "0" is a real answer and
   * means nothing is owed; "could not load" is a different thing entirely, and
   * a tailor must never read the second as the first. So an error is kept
   * apart from the figures and the whole screen says so. */
  function firstError(results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i] && results[i].error) return results[i].error;
    }
    return null;
  }

  /* The dashboard is the one page that reads across areas, because it reports
   * the whole shop. So it is also the one page where a narrowed account matters:
   * a tailor granted the dashboard but not bills should not have every live bill
   * balance sitting in their browser, and one granted payments but not orders
   * should not have the order book.
   *
   * An area the person cannot read is not queried at all, and its tile says so
   * rather than showing a number. The distinction matters and is the same one
   * this file already made for a failed load: "0" means nothing is owed, and
   * "not in your access" means the question was never asked.
   *
   * This is not access control. The database lets any active member read these
   * tables, and the anon key is public, so the rows are not beyond reach - the
   * app just stops going to look for them. See the note on canRead() in auth.js. */
  function canRead(areaId) {
    return window.ANT.auth.canRead(areaId);
  }

  function withheld(areaId) {
    return { withheld: areaId, error: null, data: [] };
  }

  function load() {
    var today = isoToday();
    var week = isoWeekStart();

    var wantOrders = canRead('orders');
    var wantBills = canRead('bills');
    var wantPayments = canRead('payments');

    var orders = wantOrders
      ? sb().from('orders')
          .select('id,code,status,order_date,delivery_date,balance,priority,customer:customers(id,code,name)')
          .neq('status', 'Cancelled')
          .is('archived_at', null)
      : withheld('orders');

    var bills = wantBills
      ? sb().from('bills')
          .select('id,balance')
          .is('archived_at', null)
      : withheld('bills');

    var payments = wantPayments
      ? sb().from('payments')
          .select('id,amount,paid_on')
          .gte('paid_on', week)
      : withheld('payments');

    return Promise.all([orders, bills, payments]).then(function (res) {
      var err = firstError(res);
      if (err) {
        state.error = (err && err.message) || 'The figures could not be loaded.';
        state.loaded = false;
        state.held = null;
        return;
      }

      // Which areas were left unasked, so the tiles can name the gap instead of
      // implying an answer they never received.
      state.held = [];
      if (res[0].withheld) state.held.push('orders');
      if (res[1].withheld) state.held.push('bills');
      if (res[2].withheld) state.held.push('payments');

      var rows = res[0].data || [];
      var billRows = res[1].data || [];
      var payRows = res[2].data || [];

      state.error = '';
      state.loaded = true;

      state.ordersToday = rows.filter(function (o) {
        return o.order_date === today;
      }).length;

      state.inProgress = rows.filter(function (o) {
        return o.status === 'In Progress';
      }).length;

      state.ready = rows.filter(function (o) {
        return o.status === 'Ready';
      }).length;

      // Counted on delivery_date rather than a status change time, because the
      // legacy system only ever recorded when a garment was due to be handed
      // over, and that is the date a tailor recognises.
      state.deliveredWeek = rows.filter(function (o) {
        return o.status === 'Delivered'
          && o.delivery_date
          && String(o.delivery_date).slice(0, 10) >= week;
      }).length;

      // Urgent is a subset of the three live statuses, not a fourth list, so a
      // garment cannot be double counted on two tiles.
      state.urgent = rows.filter(function (o) {
        return o.priority === 'Urgent'
          && (o.status === 'Pending' || o.status === 'In Progress' || o.status === 'Ready');
      }).length;

      // The bench is what is still to be cut or finished. A Pending order has
      // not been started, so it is not on the bench yet; In Progress and Ready
      // are both work in hand, and Ready is the one a customer is waiting on.
      state.bench = rows.filter(function (o) {
        return o.status === 'In Progress' || o.status === 'Ready';
      }).sort(function (a, b) {
        var ad = String(a.delivery_date || '9999-99-99');
        var bd = String(b.delivery_date || '9999-99-99');
        if (ad === bd) return String(a.code) < String(b.code) ? -1 : 1;
        return ad < bd ? -1 : 1;
      }).slice(0, BENCH_LIMIT);

      // A settled bill carries a zero or negative balance after rounding, and
      // is not owed anything, so it is left out of the total.
      state.outstanding = billRows.reduce(function (sum, b) {
        var due = num(b.balance);
        return due > 0 ? sum + due : sum;
      }, 0);

      state.collectedWeek = payRows.reduce(function (sum, p) {
        return sum + num(p.amount);
      }, 0);
    });
  }

  function statTile(label, value, foot, hero) {
    return '<div class="stat' + (hero ? ' dashboard-hero' : '') + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(value) + '</div>' +
      '<div class="stat-foot">' + esc(foot) + '</div>' +
    '</div>';
  }

  /* A tile for a figure the account was not allowed to ask for. It reads as a
   * blank rather than a zero, for the same reason a failed load does not draw
   * zeros: a tailor must not act on a number the app never fetched. */
  function heldTile(label, hero) {
    return '<div class="stat' + (hero ? ' dashboard-hero' : '') + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">—</div>' +
      '<div class="stat-foot">Not in your access</div>' +
    '</div>';
  }

  function head() {
    return '<div class="page-head"><div>' +
      '<h1 class="page-head-title">Dashboard</h1>' +
      '<p class="page-head-sub">Today at a glance for the shop.</p>' +
      '</div>' +
    '</div>';
  }

  function held(area) {
    return state.held && state.held.indexOf(area) !== -1;
  }

  function tiles() {
    // Grouped by the area each figure is read from, so a held area takes its
    // tiles with it. Orders feeds five of the six, so a tailor with the
    // dashboard but no orders sees a screen that says what it cannot see.
    var orderTiles = held('orders')
      ? heldTile('Orders today') + heldTile('In progress') + heldTile('Ready') +
        heldTile('Delivered this week')
      : statTile('Orders today', String(state.ordersToday), 'New orders taken today') +
        statTile('In progress', String(state.inProgress), 'Taken but not yet ready') +
        statTile('Ready', String(state.ready), 'Finished, waiting for pickup') +
        statTile('Delivered this week', String(state.deliveredWeek), 'Handed over since Monday');

    return (held('bills')
      ? heldTile('Outstanding', true)
      : statTile('Outstanding', money(state.outstanding), 'Money still owed on live bills', true)) +
      (held('payments')
        ? heldTile('Collected this week', true)
        : statTile('Collected this week', money(state.collectedWeek), 'Payments taken since Monday', true)) +
      orderTiles;
  }

  function loading() {
    return '<div class="dashboard-grid">' +
      statTile('Outstanding', '—', 'Loading', true) +
      statTile('Collected this week', '—', 'Loading', true) +
      statTile('Orders today', '—', 'Loading') +
      statTile('In progress', '—', 'Loading') +
      statTile('Ready', '—', 'Loading') +
      statTile('Delivered this week', '—', 'Loading') +
      '</div>';
  }

  /* Deliberately does not draw zeros. A failed load that showed the real
   * layout with ₹0.00 in it would be indistinguishable from a genuinely
   * empty shop, and the tailor would act on it. */
  function failed(message) {
    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">The figures could not be loaded</h2>' +
      '<p class="ui-card-sub">' + esc(message) + '</p>' +
      '<p class="ui-card-sub">Check the connection and tap Retry. Nothing has been lost; ' +
      'these figures are only read, never written.</p>' +
      '<div class="ui-card-actions">' +
      '<button class="btn btn-primary" data-dash-retry>Retry</button>' +
      '</div>' +
    '</div>';
  }

  function dateLabel(iso) {
    var s = String(iso == null ? '' : iso).slice(0, 10);
    if (!s) return 'no date';

    var parts = s.split('-');
    if (parts.length !== 3) return s;

    return Number(parts[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(parts[1]) - 1];
  }

  /* The bench list. A tailor opening the shop wants to know which job to pick
   * up, so this names the customer, the order and when it is due, and marks
   * the one that is finished and only waiting to be handed over. */
  function benchCard() {
    // The bench is a list of orders by name, so it goes with the orders area
    // rather than reporting itself as an empty shop.
    if (held('orders')) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">On the bench</h2>' +
        '<p class="ui-card-sub">The bench is a list of live orders, and Orders is not in your access.</p>' +
      '</div>';
    }

    if (!state.bench.length) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Nothing on the bench</h2>' +
        '<p class="ui-card-sub">No order is in progress or waiting for pickup right now.</p>' +
      '</div>';
    }

    var rows = state.bench.map(function (o) {
      var c = o.customer || {};
      var due = dateLabel(o.delivery_date);
      var waiting = o.status === 'Ready';

      var dueText = waiting ? 'awaiting pickup' : due;
      if (o.priority === 'Urgent' && !waiting) dueText += ' \u00b7 Urgent';

      return '<tr>' +
        '<td>' + (waiting
          ? '<span class="chip chip-success">Ready</span>'
          : '<span class="chip">' + esc(o.status) + '</span>') + '</td>' +
        '<td><span class="ord-sub-strong">' + esc(c.name || 'Unknown customer') + '</span></td>' +
        '<td>' + esc(o.code) + '</td>' +
        '<td>' + esc(dueText) + '</td>' +
      '</tr>';
    }).join('');

    var more = state.inProgress + state.ready - state.bench.length;

    return '<div class="ui-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">On the bench</h2>' +
      '<p class="ui-card-sub">' + (state.inProgress + state.ready) +
        ' order' + (state.inProgress + state.ready === 1 ? '' : 's') +
        ' in hand, soonest due first.</p>' +
      '<div class="table-wrap"><table class="ui-table"><thead><tr>' +
        '<th>Status</th><th>Customer</th><th>Order</th><th>Due</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (more > 0
        ? '<p class="ui-card-sub" style="margin-top:var(--gap-sm)">' + more +
          ' more on <a href="#/orders">Orders</a>.</p>'
        : '') +
    '</div>';
  }

  function body() {
    if (state.error) return failed(state.error);
    if (!state.loaded) return loading();

    return '<div class="dashboard-grid">' + tiles() + '</div>' + benchCard() + heldNote();
  }

  /* When any figure is missing for want of access rather than want of data, say
   * it once, at the bottom. The tiles already mark themselves, and this is here
   * so the reason is stated rather than left for the tailor to work out - a
   * blank that nobody explains looks like a fault. */
  function heldNote() {
    if (!state.held || !state.held.length) return '';

    var names = { orders: 'Orders', bills: 'Bills', payments: 'Payments' };
    var list = state.held.map(function (a) { return names[a] || a; });

    return '<div class="ui-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">Some figures are not shown</h2>' +
      '<p class="ui-card-sub">' +
        esc(list.join(', ')) + (list.length === 1 ? ' is' : ' are') +
        ' not in your access, so ' + (list.length === 1 ? 'that figure was' : 'those figures were') +
        ' not asked for. Ask the shop owner if you need it.</p>' +
    '</div>';
  }

  function paint() {
    var host = byId('dashView');
    if (!host) return;
    host.innerHTML = head() + body();

    var retry = host.querySelector('[data-dash-retry]');
    if (retry) {
      retry.addEventListener('click', function () {
        state.loaded = false;
        state.error = '';
        paint();
        render();
      });
    }
  }

  function mount() {
    return '<div id="dashView"></div>';
  }

  function render() {
    paint();
    return load().then(paint);
  }

  return { mount: mount, render: render, isoWeekStart: isoWeekStart, isoToday: isoToday };
})();

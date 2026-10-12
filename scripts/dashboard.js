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

  function diffDays(a, b) {
    var pa = String(a == null ? '' : a).split('-');
    var pb = String(b == null ? '' : b).split('-');
    if (pa.length !== 3 || pb.length !== 3) return null;
    var da = new Date(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
    var db = new Date(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
    return Math.round(Math.abs((db - da) / 86400000));
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

  /* A calendar date shifted by whole days, kept in local time for the same
   * reason isoToday() is: a delivery date is the shop's day, and a date one day
   * out would put a job in the wrong bucket. */
  function addDays(iso, n) {
    var p = String(iso == null ? '' : iso).split('-');
    if (p.length !== 3) return iso;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + n);
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
    pending: 0,
    inProgress: 0,
    ready: 0,
    deliveredWeek: 0,
    outstanding: 0,
    collectedWeek: 0,
    urgent: 0,
    avgDeliverDays: null,
    /* The jobs themselves, so the screen says what needs doing rather than only
     * how many. Capped: this is a glance, not a work list, and the full list
     * already exists on the Orders page. */
    bench: [],
    /* How many orders are still owed to a customer, split by status. The bench
     * itself is capped; these are the whole book, so the subtitle can say what
     * is counted even when the list is shortened. */
    live: { total: 0, pending: 0, process: 0, finish: 0 },
    /* Every open order split by the day the customer expects it, so the shop can
     * see at a glance what is late and what is coming. Counted on the order's
     * delivery_date - the latest of its items - the same date a bill prints. */
    tracker: { overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, none: 0 },
    /* The same open orders split by the date the shop promised the garment, not
     * by when it is due to be handed over. A promise is what a customer holds
     * the shop to, so an overdue promise is a phone call, not a number. The
     * overdue and today buckets keep the orders themselves, so the board can
     * name who is waiting. */
    promise: { overdue: [], today: [], upcoming: [], later: 0, none: 0 },
    /* Resale items whose available count has fallen to their own restock
     * threshold, capped for the glance. */
    lowStock: []
  };

  var BENCH_LIMIT = 12;

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
    var wantResale = canRead('resale');

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

    var resale = wantResale
      ? sb().from('resale_stock')
          .select('id,item,quantity')
      : withheld('resale');

    return Promise.all([orders, bills, payments, resale]).then(function (res) {
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
      if (res[3].withheld) state.held.push('resale');

      var rows = res[0].data || [];
      var billRows = res[1].data || [];
      var payRows = res[2].data || [];
      var stockRows = res[3].data || [];

      state.error = '';
      state.loaded = true;

      state.ordersToday = rows.filter(function (o) {
        return o.order_date === today;
      }).length;

      state.pending = rows.filter(function (o) {
        return o.status === 'Pending';
      }).length;

      state.inProgress = rows.filter(function (o) {
        return o.status === 'Process';
      }).length;

      state.ready = rows.filter(function (o) {
        return o.status === 'Finish';
      }).length;

      // Counted on delivery_date rather than a status change time, because the
      // legacy system only ever recorded when a garment was due to be handed
      // over, and that is the date a tailor recognises.
      state.deliveredWeek = rows.filter(function (o) {
        return o.status === 'Delivery'
          && o.delivery_date
          && String(o.delivery_date).slice(0, 10) >= week;
      }).length;

      // The delivery tracker: every open order - not yet handed over, not
      // cancelled, not archived (the query already dropped those) - split by the
      // day the customer expects it. An order with no date is its own bucket
      // rather than being counted as due today, because a job nobody dated is a
      // job somebody still has to schedule, which is a different problem.
      var tomorrow = addDays(today, 1);
      var weekEnd = addDays(week, 6);
      state.tracker = { overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, none: 0 };
      rows.forEach(function (o) {
        if (o.status === 'Delivery') return;
        var d = String(o.delivery_date || '').slice(0, 10);
        if (!d) state.tracker.none++;
        else if (d < today) state.tracker.overdue++;
        else if (d === today) state.tracker.today++;
        else if (d === tomorrow) state.tracker.tomorrow++;
        else if (d <= weekEnd) state.tracker.week++;
        else state.tracker.later++;
      });

      // Urgent is a subset of the three live statuses, not a fourth list, so a
      // garment cannot be double counted on two tiles.
      state.urgent = rows.filter(function (o) {
        return o.priority === 'Urgent'
          && (o.status === 'Pending' || o.status === 'Process' || o.status === 'Finish');
      }).length;

      // The bench is every order still owed to a customer: not yet handed over
      // (Delivery) and not called off (Cancelled, already dropped by the query).
      // That is Pending, Process and Finish - and it does not hinge on those
      // three strings being spelled exactly, so an order with no status yet
      // appears too rather than quietly going missing.
      var live = rows.filter(function (o) {
        return o.status !== 'Delivery' && o.status !== 'Cancelled';
      });

      state.live = { total: live.length, pending: 0, process: 0, finish: 0 };
      live.forEach(function (o) {
        if (o.status === 'Process') state.live.process++;
        else if (o.status === 'Finish') state.live.finish++;
        else state.live.pending++;
      });

      state.bench = live.sort(function (a, b) {
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

      // Time to deliver: whole days from the order being taken to the garment
      // being handed over, averaged over delivered orders. Delivered is
      // measured on the delivery_date because that is the date the shop already
      // records - a separate "finished at" stamp would have to be taught to
      // every old order.
      var delays = rows.filter(function (o) {
        return o.status === 'Delivery' && o.order_date && o.delivery_date;
      }).map(function (o) {
        return diffDays(o.order_date, o.delivery_date);
      }).filter(function (d) { return d !== null; });
      state.avgDeliverDays = delays.length
        ? Math.round(delays.reduce(function (a, b) { return a + b; }, 0) / delays.length)
        : null;

      // The promise board: the same open orders as the delivery tracker, but by
      // the date actually promised to the customer instead of the due date the
      // shop set. Overdue and due-today keep the orders so the board can name
      // who is waiting; the rest are counts.
      var upEnd = addDays(today, 3);
      state.promise = { overdue: [], today: [], upcoming: [], later: 0, none: 0 };
      rows.forEach(function (o) {
        if (o.status === 'Delivery') return;
        var d = String(o.promise_date || '').slice(0, 10);
        if (!d) state.promise.none++;
        else if (d < today) state.promise.overdue.push(o);
        else if (d === today) state.promise.today.push(o);
        else if (d <= upEnd) state.promise.upcoming.push(o);
        else state.promise.later++;
      });
      state.promise.overdue = state.promise.overdue.slice(0, 6);
      state.promise.today = state.promise.today.slice(0, 6);

      // Items sitting at or under their own restock threshold, smallest first,
      // capped for the glance. A threshold of zero means "do not track" and is
      // not an alert.
      state.lowStock = stockRows
        .map(function (r) {
          return {
            name: r.item || r.name,
            variant: r.variant || null,
            available: num(r.quantity !== undefined && r.quantity !== null ? r.quantity : r.available),
            min_qty: r.min_qty != null && r.min_qty !== undefined ? num(r.min_qty) : 0,
            unit: r.unit || null
          };
        })
        .filter(function (r) { return r.min_qty > 0 && r.available <= r.min_qty; })
        .sort(function (a, b) { return a.available - b.available; })
        .slice(0, 6);
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
    // tiles with it. Orders feeds five of the seven, so a tailor with the
    // dashboard but no orders sees a screen that says what it cannot see.
    var orderTiles = held('orders')
      ? heldTile('Orders today') + heldTile('Process') + heldTile('Finish') +
        heldTile('Delivered this week') + heldTile('Avg time to deliver')
      : statTile('Orders today', String(state.ordersToday), 'New orders taken today') +
        statTile('Process', String(state.inProgress), 'Taken but not yet ready') +
        statTile('Finish', String(state.ready), 'Finished, waiting for pickup') +
        statTile('Delivered this week', String(state.deliveredWeek), 'Handed over since Monday') +
        statTile('Avg time to deliver',
          state.avgDeliverDays === null ? '—' : String(state.avgDeliverDays) + ' days',
          state.avgDeliverDays === null ? 'No delivered orders yet' : 'Days from order to hand-over');

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
      statTile('Process', '—', 'Loading') +
      statTile('Finish', '—', 'Loading') +
      statTile('Delivered this week', '—', 'Loading') +
      '</div>';
  }

  /* The delivery tracker, in the shop's own words: what is late, what is due
   * now, and what is coming. Each figure is a bucket of the same open orders the
   * tiles count, so the tracker and the tiles can never disagree, and a bucket
   * with nothing in it still shows a real 0 rather than disappearing. */
  function tracker() {
    if (held('orders')) {
      return '<div class="ui-card tracker-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Delivery tracker</h2>' +
        '<p class="ui-card-sub">The tracker is built from live orders, and Orders is not in your access.</p>' +
      '</div>';
    }

    var t = state.tracker;
    var open = t.overdue + t.today + t.tomorrow + t.week + t.later + t.none;

    var item = function (key, label, value, tone) {
      return '<div class="tracker-item ' + tone + '" data-tracker="' + key + '">' +
        '<div class="tracker-count">' + value + '</div>' +
        '<div class="tracker-label">' + esc(label) + '</div>' +
      '</div>';
    };

    return '<div class="ui-card tracker-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">Delivery tracker</h2>' +
      '<p class="ui-card-sub">' + open + ' open order' + (open === 1 ? '' : 's') +
        ' by the day the customer expects them.</p>' +
      '<div class="tracker-grid">' +
        item('overdue', 'Overdue', t.overdue, 'tone-bad') +
        item('today', 'Due today', t.today, 'tone-warn') +
        item('tomorrow', 'Due tomorrow', t.tomorrow, 'tone-info') +
        item('week', 'Due this week', t.week, 'tone-info') +
        item('later', 'Later', t.later, 'tone-plain') +
        item('none', 'No delivery date', t.none, 'tone-muted') +
      '</div>' +
    '</div>';
  }

  /* The promise board. The delivery tracker above answers "when will it be
   * done?"; this answers "what did we tell the customer?" and keeps the two
   * honest. An order promised on a date that has passed is named by customer
   * and order - that is the phone call list - and the overdue and today
   * buckets keep the rows rather than just counts, capped like the bench. */
  function promiseBoard() {
    if (held('orders')) {
      return '<div class="ui-card tracker-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Promised dates</h2>' +
        '<p class="ui-card-sub">Promised dates come from live orders, and Orders is not in your access.</p>' +
      '</div>';
    }

    var p = state.promise;
    var open = p.overdue.length + p.today.length + p.upcoming.length + p.later + p.none;

    var item = function (key, label, value, tone) {
      return '<div class="tracker-item ' + tone + '" data-promise="' + key + '">' +
        '<div class="tracker-count">' + value + '</div>' +
        '<div class="tracker-label">' + esc(label) + '</div>' +
      '</div>';
    };

    // The overdue and today buckets carry the names, so the shop can act on the
    // board instead of opening the order list to work out who is waiting.
    var named = [];
    p.overdue.concat(p.today).slice(0, 6).forEach(function (o) {
      var c = o.customer || {};
      var late = p.overdue.indexOf(o) !== -1;
      named.push('<tr>' +
        '<td>' + (late ? '<span class="chip chip-danger">Overdue</span>' : '<span class="chip chip-warn">Due today</span>') + '</td>' +
        '<td><span class="ord-sub-strong">' + esc(c.name || 'Unknown customer') + '</span></td>' +
        '<td>' + esc(o.code) + '</td>' +
        '<td>' + esc(dateLabel(o.promise_date)) + '</td>' +
      '</tr>');
    });

    return '<div class="ui-card tracker-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">Promised dates</h2>' +
      '<p class="ui-card-sub">' + open + ' promised order' + (open === 1 ? '' : 's') +
        ' by the date given to the customer.</p>' +
      '<div class="tracker-grid">' +
        item('overdue', 'Overdue', p.overdue.length, 'tone-bad') +
        item('today', 'Due today', p.today.length, 'tone-warn') +
        item('upcoming', 'Next 3 days', p.upcoming.length, 'tone-info') +
        item('later', 'Later', p.later, 'tone-plain') +
        item('none', 'No promise date', p.none, 'tone-muted') +
      '</div>' +
      (named.length
        ? '<div class="table-wrap" style="margin-top:var(--gap-sm)"><table class="ui-table"><thead><tr>' +
          '<th>Status</th><th>Customer</th><th>Order</th><th>Promise</th>' +
          '</tr></thead><tbody>' + named.join('') + '</tbody></table>' +
          '<p class="ui-card-sub" style="margin-top:var(--gap-sm)">' +
            'Promise more on <a href="#/orders">Orders</a>.</p></div>'
        : '') +
    '</div>';
  }

  /* Restock alerts. A resale item reads the shop for quantities, and is a
   * quiet habit - nobody notices until a sale is refused for want of stock.
   * The card names the items that have reached their own threshold, so the
   * habit happens while there is still time. */
  function restockCard() {
    if (held('resale')) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Restock alerts</h2>' +
        '<p class="ui-card-sub">Restock alerts read Resale stock, and Resale is not in your access.</p>' +
      '</div>';
    }

    if (!state.lowStock.length) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">No restock alerts</h2>' +
        '<p class="ui-card-sub">Nothing on the shelves is at or under its own restock threshold.</p>' +
      '</div>';
    }

    var chips = state.lowStock.map(function (r) {
      var label = (r.name || 'Unknown') + (r.variant ? ' ' + r.variant : '');
      return '<span class="chip chip-warn">' + esc(label) + ' (' +
        esc(String(r.available)) + (r.unit ? ' ' + esc(r.unit) : '') + ' left)</span>';
    }).join(' ');

    return '<div class="ui-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">Restock alerts</h2>' +
      '<p class="ui-card-sub">Resale items at or under their own restock threshold.</p>' +
      '<div class="card-chips">' + chips + '</div>' +
      '<p class="ui-card-sub" style="margin-top:var(--gap-sm)">Restock on <a href="#/resale">Resale Stock</a>.</p>' +
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

  /* The status of a benched order and the steps still ahead of it - the same
   * straight line Orders uses, Pending -> Process -> Finish -> Delivery, with
   * Cancel alongside. A tap advances the order and the dashboard reloads, so
   * the bench is where the day's work gets moved along, not just read. */
  function benchStatus(o) {
    var status = o.status || 'Pending';
    var kind = status === 'Finish' ? 'chip-success'
      : (status === 'Pending' ? 'chip-warn' : 'chip-info');
    var chip = '<span class="chip ' + kind + '">' + esc(status) + '</span>';

    var flow = ['Pending', 'Process', 'Finish', 'Delivery'];
    var at = flow.indexOf(status);
    if (at < 0) at = 0;
    var ahead = flow.slice(at + 1);
    var buttons = ahead.map(function (st) {
      var cls = st === 'Delivery' ? 'btn-success' : 'btn-secondary';
      return '<button type="button" class="btn btn-sm ' + cls + ' bench-set" ' +
        'data-bench-id="' + esc(o.id) + '" data-bench-cur="' + esc(status) +
        '" data-bench-next="' + esc(st) + '">' + esc(st) + '</button>';
    }).join('');

    if (status !== 'Delivery' && status !== 'Cancelled') {
      buttons += '<button type="button" class="btn btn-sm btn-danger bench-set" ' +
        'data-bench-id="' + esc(o.id) + '" data-bench-cur="' + esc(status) +
        '" data-bench-next="Cancelled">Cancel</button>';
    }

    return '<div class="ord-status-wrap">' + chip +
      (buttons ? '<span class="ord-status-actions">' + buttons + '</span>' : '') + '</div>';
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
        '<p class="ui-card-sub">No order is open right now.</p>' +
      '</div>';
    }

    var onBench = state.live.total;

    var rows = state.bench.map(function (o) {
      var c = o.customer || {};
      var due = dateLabel(o.delivery_date);
      var waiting = o.status === 'Finish';

      var dueText = waiting ? 'awaiting pickup' : due;
      if (o.priority === 'Urgent' && !waiting) dueText += ' \u00b7 Urgent';

      return '<tr>' +
        '<td>' + benchStatus(o) + '</td>' +
        '<td><span class="ord-sub-strong">' + esc(c.name || 'Unknown customer') + '</span></td>' +
        '<td>' + esc(o.code) + '</td>' +
        '<td>' + esc(dueText) + '</td>' +
      '</tr>';
    }).join('');

    var more = onBench - state.bench.length;

    return '<div class="ui-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">On the bench</h2>' +
      '<p class="ui-card-sub">' + onBench +
        ' order' + (onBench === 1 ? '' : 's') +
        ' in hand: ' + state.live.pending + ' Pending \u00b7 ' +
        state.live.process + ' Process \u00b7 ' + state.live.finish +
        ' Finish, soonest due first.</p>' +
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

    return '<div class="dashboard-grid">' + tiles() + '</div>' + promiseBoard() + tracker() + restockCard() + benchCard() + heldNote();
  }

  /* When any figure is missing for want of access rather than want of data, say
   * it once, at the bottom. The tiles already mark themselves, and this is here
   * so the reason is stated rather than left for the tailor to work out - a
   * blank that nobody explains looks like a fault. */
  function heldNote() {
    if (!state.held || !state.held.length) return '';

    var names = { orders: 'Orders', bills: 'Bills', payments: 'Payments', resale: 'Resale Stock' };
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

    Array.prototype.forEach.call(host.querySelectorAll('.bench-set'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-bench-id');
        var next = btn.getAttribute('data-bench-next');
        var cur = btn.getAttribute('data-bench-cur');
        var orders = window.ANT.orders;
        if (!orders || typeof orders.applyStatus !== 'function') return;
        btn.disabled = true;
        orders.applyStatus(id, next, cur, function () { render(); }, function () {
          btn.disabled = false;
        });
      });
    });
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

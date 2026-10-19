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
    lowStock: [],
    money: { shop: {}, items: [], loaded: false, error: null }
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
          .select('id,code,status,order_date,delivery_date,promise_date,balance,total,advance,priority,customer:customers(id,code,name,mobile)')
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

    var shop = canRead('orders') || canRead('bills') || canRead('payments')
      ? sb().from('shop_settings').select('key,value')
      : withheld('shop');

    return Promise.all([orders, bills, payments, resale, shop]).then(function (res) {
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
      if (res[4] && res[4].withheld) { /* shop settings withheld - harmless */ }

      var rows = res[0].data || [];
      var billRows = res[1].data || [];
      var payRows = res[2].data || [];
      var stockRows = res[3].data || [];
      var shopRows = (res[4] && res[4].data && !res[4].withheld) ? res[4].data : [];

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

      var shop = { name: '', upiId: '', payee: '', waReminderMessage: '', payment_terms: '', due_reminder_days: '' };
      shopRows.forEach(function (r) {
        if (r.key === 'shop_name') shop.name = String(r.value || '');
        else if (r.key === 'upi_id') shop.upiId = String(r.value || '');
        else if (r.key === 'upi_payee_name') shop.payee = String(r.value || '');
        else if (r.key === 'wa_reminder_message') shop.waReminderMessage = String(r.value || '');
        else if (r.key === 'payment_terms') shop.payment_terms = String(r.value || '');
        else if (r.key === 'due_reminder_days') shop.due_reminder_days = String(r.value || '');
      });
      state.money.shop = shop;

      var reminderSet = {};
      (shop.due_reminder_days || '').split(/[,;\s]+/).forEach(function (s) {
        var d = parseInt(s, 10);
        if (!isNaN(d) && d >= 0) reminderSet[d] = true;
      });
      var reminders = Object.keys(reminderSet).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });

      var moneyItems = [];
      rows.forEach(function (o) {
        var due = num(o.balance);
        if (due <= 0 || o.status === 'Cancelled') return;
        var d = String(o.delivery_date || '').slice(0, 10);
        var aged = 0;
        if (d) {
          var delta = (new Date(today) - new Date(d + 'T00:00:00')) / 86400000;
          if (delta > 0) aged = Math.floor(delta);
        }
        var bucket = aged <= 0 ? 'due' : (aged <= 7 ? '7' : (aged <= 30 ? '30' : (aged <= 60 ? '60' : '90')));
        var nudge = null;
        if (d && aged > 0) {
          for (var i = 0; i < reminders.length; i++) {
            if (aged >= reminders[i]) nudge = reminders[i];
          }
        }
        moneyItems.push({
          order: o,
          customer: o.customer,
          due: due,
          aged: aged,
          bucket: bucket,
          nudge: nudge,
          delivery: d
        });
      });
      moneyItems.sort(function (a, b) {
        if (b.due !== a.due) return b.due - a.due;
        var ad = String(a.delivery || '9999-99-99');
        var bd = String(b.delivery || '9999-99-99');
        return ad < bd ? -1 : 1;
      });
      state.money.items = moneyItems;
      state.money.loaded = true;
      state.money.error = null;

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

  function moneyToCollect() {
    if (held('orders')) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Money to collect</h2>' +
        '<p class="ui-card-sub">Live orders not in your access.</p>' +
      '</div>';
    }

    var m = state.money || { items: [], shop: {} };
    var items = m.items || [];
    if (!items.length) {
      return '<div class="ui-card" style="margin-top:var(--gap)">' +
        '<h2 class="ui-card-title">Money to collect</h2>' +
        '<p class="ui-card-sub">Nothing outstanding right now.</p>' +
      '</div>';
    }

    var sums = { due: 0, '7': 0, '30': 0, '60': 0, '90': 0 };
    var total = 0;
    items.forEach(function (it) {
      total += num(it.due);
      var b = it.bucket;
      if (sums[b] !== undefined) sums[b] += num(it.due);
      else sums.due += num(it.due);
    });

    var chips = '<div class="card-chips">' +
      ['due', '7', '30', '60', '90'].map(function (k) {
        var label = k === 'due' ? 'Due now' : ('>' + k + 'd');
        return '<span class="chip chip-plain">' + esc(label) + ': ' + esc(money(sums[k])) + '</span>';
      }).join(' ') +
      '<span class="chip chip-info">Total: ' + esc(money(total)) + '</span>' +
    '</div>';

    var rows = items.slice(0, 20).map(function (it) {
      var c = it.customer || {};
      var o = it.order || {};
      var aged = it.aged > 0 ? it.aged + 'd' : 'due';
      var nudge = it.nudge != null ? ' (nudge ' + it.nudge + 'd)' : '';
      return '<tr>' +
        '<td>' + esc(c.name || '—') + '</td>' +
        '<td>' + esc(o.code || '') + '</td>' +
        '<td>' + esc(dateLabel(it.delivery)) + '</td>' +
        '<td>' + esc(aged) + nudge + '</td>' +
        '<td class="num">' + esc(money(it.due)) + '</td>' +
        '<td class="ord-row-actions">' +
          '<button class="btn btn-sm btn-secondary dash-remind" data-dash-order="' + esc(o.id) + '">Remind</button>' +
          '<button class="btn btn-sm btn-primary dash-received" data-dash-order="' + esc(o.id) + '">Received</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    var reachable = items.filter(function (it) {
      return it.customer && it.customer.mobile;
    }).length;

    return '<div class="ui-card" style="margin-top:var(--gap)">' +
      '<h2 class="ui-card-title">Money to collect</h2>' +
      '<p class="ui-card-sub">Outstanding balances grouped by ageing. One-tap Remind or Received.</p>' +
      chips +
      '<div class="table-wrap" style="margin-top:var(--gap-sm)"><table class="ui-table"><thead><tr>' +
        '<th>Customer</th><th>Order</th><th>Delivery</th><th>Age</th><th class="num">Due</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="ui-card-actions" style="margin-top:var(--gap-sm)">' +
        (reachable > 1
          ? '<button class="btn btn-sm btn-secondary" data-dash-remind-all>Remind all (' + reachable + ')</button> '
          : '') +
        '<button class="btn btn-sm btn-secondary" data-dash-stmt>Customer statement (WhatsApp)</button>' +
      '</div>' +
      '<div data-dash-remind-panel></div>' +
      '<div data-dash-stmt-panel></div>' +
    '</div>';
  }

  function body() {
    if (state.error) return failed(state.error);
    if (!state.loaded) return loading();

    return '<div class="dashboard-grid">' + tiles() + '</div>' + moneyToCollect() + promiseBoard() + tracker() + restockCard() + benchCard() + heldNote();
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

  function findMoneyItem(id) {
    var found = null;
    (state.money && state.money.items || []).forEach(function (x) {
      if (x.order && x.order.id === id) found = x;
    });
    return found;
  }

  // One place builds a reminder link, so the single Remind button and the
  // batch list cannot drift apart.
  function reminderUrl(it) {
    if (!it || !it.customer || !it.customer.mobile) return '';
    var wa = window.ANT.whatsapp;
    if (!wa || !wa.link || !wa.reminderMessage) return '';
    var o = it.order || {};
    var msg = wa.reminderMessage({
      shop: (state.money && state.money.shop) || {},
      customer: it.customer,
      bill: { code: o.code, bill_amount: o.total, advance: o.advance, balance: o.balance },
      orders: [o]
    });
    return wa.link(it.customer.mobile, msg);
  }

  // A statement belongs to one customer, so the outstanding rows are grouped by
  // who owes before one is drawn up. The button used to list every customer's
  // orders under the first customer's name, which is not a statement anybody
  // should send.
  function groupMoneyByCustomer(items) {
    var out = [], byKey = {};
    (items || []).forEach(function (it) {
      var c = it.customer || {};
      var key = c.id || ((c.name || '') + '|' + (c.mobile || ''));
      var g = byKey[key];
      if (!g) {
        g = { customer: c, items: [], due: 0 };
        byKey[key] = g;
        out.push(g);
      }
      g.items.push(it);
      g.due += num(it.due);
    });
    return out;
  }

  // The statement as the customer will read it: the orders they still owe on,
  // then every payment already received against them - so a customer who has
  // paid part is shown that, instead of a figure that looks like nothing was
  // paid at all.
  function statementText(group, paymentRows) {
    var shop = (state.money && state.money.shop) || {};
    var c = group.customer || {};
    var lines = [];

    lines.push(shop.name || 'AN TAILOR');
    lines.push('Customer Statement');
    lines.push(isoToday());
    lines.push('');
    lines.push((c.name || 'Customer') + (c.mobile ? '  ' + c.mobile : ''));
    lines.push('');
    lines.push('Orders');
    var billed = 0;
    group.items.forEach(function (it) {
      var o = it.order || {};
      var total = num(o.total);
      billed += total;
      lines.push('  ' + (o.code || '') + '  ' + money(total) +
        '  balance ' + money(it.due) +
        (it.delivery ? '  (due ' + it.delivery + ')' : ''));
    });

    var paid = 0;
    var rows = (paymentRows || []).slice().sort(function (a, b) {
      return String(a.paid_on || '') < String(b.paid_on || '') ? -1 : 1;
    });
    if (rows.length) {
      lines.push('');
      lines.push('Payments received');
      rows.forEach(function (p) {
        paid += num(p.amount);
        lines.push('  ' + (p.paid_on || '') + '  ' + money(p.amount) +
          (p.method ? '  ' + p.method : ''));
      });
    }

    lines.push('');
    lines.push('Total billed: ' + money(billed));
    lines.push('Total paid: ' + money(paid));
    lines.push('Balance due: ' + money(group.due));
    lines.push('');
    lines.push('- ' + (shop.name || 'AN TAILOR'));
    return lines.join('\n');
  }

  function sendStatement(group) {
    var c = group.customer || {};
    if (!c.mobile) {
      window.ANT.toast && window.ANT.toast('No mobile number for this customer.', 'error');
      return;
    }
    var ids = group.items.map(function (it) { return it.order && it.order.id; })
      .filter(Boolean);

    var read = ids.length
      ? sb().from('payments')
          .select('id,amount,method,paid_on,order_id')
          .in('order_id', ids)
      : Promise.resolve({ data: [] });

    read.then(function (res) {
      var rows = (res && !res.error && res.data) || [];
      var wa = window.ANT.whatsapp;
      var link = wa && wa.link ? wa.link(c.mobile, statementText(group, rows)) : '';
      if (!link) {
        window.ANT.toast && window.ANT.toast('Could not build statement link.', 'error');
        return;
      }
      window.open(link, '_blank', 'noopener');
    }).catch(function (e) {
      window.ANT.toast && window.ANT.toast(e && e.message ? e.message : String(e), 'error');
    });
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
        var order = null;
        state.bench.forEach(function (o) { if (o.id === id) order = o; });
        btn.disabled = true;
        orders.applyStatus(id, next, cur, function () { render(); }, function () {
          btn.disabled = false;
        }, order);
      });
    });

    Array.prototype.forEach.call(host.querySelectorAll('.dash-remind'), function (btn) {
      btn.addEventListener('click', function () {
        var it = findMoneyItem(btn.getAttribute('data-dash-order'));
        if (!it || !it.customer || !it.customer.mobile) {
          window.ANT.toast && window.ANT.toast('No mobile number for this customer.', 'error');
          return;
        }
        var url = reminderUrl(it);
        if (url) window.open(url, '_blank', 'noopener');
      });
    });

    // WhatsApp takes one recipient at a time, so "Remind all" is a list the
    // tailor taps through: each Send is its own tap, so no pop-up blocker eats
    // the message, and the button turns to Sent as the row is dealt with.
    var remindAll = host.querySelector('[data-dash-remind-all]');
    if (remindAll) {
      remindAll.addEventListener('click', function () {
        var panel = host.querySelector('[data-dash-remind-panel]');
        if (!panel) return;
        if (panel.firstChild) { panel.innerHTML = ''; return; }

        var list = (state.money.items || []).filter(function (it) {
          return it.customer && it.customer.mobile;
        });
        panel.innerHTML = '<p class="ui-card-sub" style="margin-top:var(--gap-sm)">' +
            'Tap Send for each reminder, one at a time.</p>' +
          '<div class="dash-remind-list">' + list.map(function (it) {
            var c = it.customer || {}, o = it.order || {};
            return '<div class="dash-remind-item">' +
              '<span>' + esc(c.name || '—') + ' · ' + esc(o.code || '') + ' · ' + esc(money(it.due)) + '</span>' +
              '<button class="btn btn-sm btn-secondary" data-dash-remind-one="' + esc(o.id) + '">Send</button>' +
            '</div>';
          }).join('') + '</div>';

        Array.prototype.forEach.call(panel.querySelectorAll('[data-dash-remind-one]'), function (b) {
          b.addEventListener('click', function () {
            var it = findMoneyItem(b.getAttribute('data-dash-remind-one'));
            var url = it ? reminderUrl(it) : '';
            if (!url) {
              window.ANT.toast && window.ANT.toast('Could not build reminder.', 'error');
              return;
            }
            window.open(url, '_blank', 'noopener');
            b.disabled = true;
            b.textContent = 'Sent';
          });
        });
      });
    }

    // A customer rarely hands over the whole balance at once, so Received opens
    // a small form for the amount, method and a note rather than quietly taking
    // everything. settle() re-reads the order and refuses an over-payment, so
    // the figure pre-filled here is a starting point and not a promise.
    function payMethods() {
      return ['Cash', 'UPI', 'Cheque', 'Card', 'Other'];
    }

    function openPayRow(row, it) {
      if (!row || !row.parentNode) return;
      var order = it.order || {};
      var due = num(it.due);
      var tr = document.createElement('tr');
      tr.className = 'dash-pay-row';
      var td = document.createElement('td');
      td.setAttribute('colspan', '6');
      td.innerHTML =
        '<div class="dash-pay-form">' +
          '<label>Amount <input class="ui-input" data-pay-amount type="number" min="0.01" step="0.01" value="' + esc(due.toFixed(2)) + '"></label>' +
          '<label>Method <select class="ui-input" data-pay-method>' +
            payMethods().map(function (mth) {
              return '<option value="' + esc(mth) + '">' + esc(mth) + '</option>';
            }).join('') +
          '</select></label>' +
          '<label>Note <input class="ui-input" data-pay-note placeholder="Optional"></label>' +
          '<button class="btn btn-sm btn-primary" data-pay-save>Save</button>' +
          '<button class="btn btn-sm btn-secondary" data-pay-full>Full ' + esc(money(due)) + '</button>' +
          '<button class="btn btn-sm btn-secondary" data-pay-cancel>Cancel</button>' +
        '</div>';
      tr.appendChild(td);
      row.parentNode.insertBefore(tr, row.nextSibling);

      var amountEl = td.querySelector('[data-pay-amount]');
      var methodEl = td.querySelector('[data-pay-method]');
      var noteEl = td.querySelector('[data-pay-note]');
      var saveEl = td.querySelector('[data-pay-save]');
      var fullEl = td.querySelector('[data-pay-full]');
      var cancelEl = td.querySelector('[data-pay-cancel]');

      cancelEl.addEventListener('click', function () {
        if (tr.parentNode) tr.parentNode.removeChild(tr);
      });

      function submit() {
        var amt = parseFloat(amountEl.value);
        if (!(amt > 0)) {
          window.ANT.toast && window.ANT.toast('Enter an amount greater than zero.', 'error');
          return;
        }
        var pay = window.ANT.payments;
        if (!pay || typeof pay.settle !== 'function') {
          window.ANT.toast && window.ANT.toast('Payments module is not ready.', 'error');
          return;
        }
        saveEl.disabled = true;
        fullEl.disabled = true;
        pay.settle(order.id, {
          amount: amt,
          method: methodEl.value || 'Cash',
          notes: (noteEl && noteEl.value || '').trim()
        }).then(function (res) {
          if (res && res.ok) {
            window.ANT.toast && window.ANT.toast('Payment of ' + money(res.amount) + ' recorded.', 'success');
            render();
          } else {
            saveEl.disabled = false;
            fullEl.disabled = false;
            window.ANT.toast && window.ANT.toast((res && res.error) || 'Payment could not be recorded.', 'error');
          }
        }).catch(function (e) {
          saveEl.disabled = false;
          fullEl.disabled = false;
          window.ANT.toast && window.ANT.toast(e && e.message ? e.message : String(e), 'error');
        });
      }

      saveEl.addEventListener('click', submit);
      fullEl.addEventListener('click', function () {
        amountEl.value = due.toFixed(2);
        submit();
      });
    }

    Array.prototype.forEach.call(host.querySelectorAll('.dash-received'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-dash-order');
        if (!id) return;
        var it = null;
        (state.money.items || []).forEach(function (x) { if (x.order && x.order.id === id) it = x; });
        if (!it) return;

        var row = btn.closest ? btn.closest('tr') : null;
        if (row && row.nextElementSibling && row.nextElementSibling.className &&
            row.nextElementSibling.className.indexOf('dash-pay-row') !== -1) {
          row.parentNode.removeChild(row.nextElementSibling);
          return;
        }
        openPayRow(row, it);
      });
    });

    var stmtBtn = host.querySelector('[data-dash-stmt]');
    if (stmtBtn) {
      stmtBtn.addEventListener('click', function () {
        var panel = host.querySelector('[data-dash-stmt-panel]');
        if (!panel) return;
        if (panel.firstChild) { panel.innerHTML = ''; return; }

        var groups = groupMoneyByCustomer(state.money.items);
        if (!groups.length) {
          window.ANT.toast && window.ANT.toast('Nothing outstanding to include in a statement.', 'info');
          return;
        }
        panel.innerHTML = '<p class="ui-card-sub" style="margin-top:var(--gap-sm)">' +
            'Choose a customer. The statement lists their orders and the payments already received.</p>' +
          '<div class="dash-remind-list">' + groups.map(function (g, i) {
            var c = g.customer || {};
            return '<div class="dash-remind-item">' +
              '<span>' + esc(c.name || '—') + ' · ' + g.items.length +
                (g.items.length === 1 ? ' order · ' : ' orders · ') + esc(money(g.due)) + '</span>' +
              '<button class="btn btn-sm btn-secondary" data-dash-stmt-one="' + i + '">Statement</button>' +
            '</div>';
          }).join('') + '</div>';

        Array.prototype.forEach.call(panel.querySelectorAll('[data-dash-stmt-one]'), function (b) {
          b.addEventListener('click', function () {
            var g = groups[Number(b.getAttribute('data-dash-stmt-one'))];
            if (g) sendStatement(g);
          });
        });
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

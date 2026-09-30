/* AN TAILOR - Resale Stock.
 *
 * Stock bought in to be sold on, as against work being cut for a customer. The
 * legacy page was called "Stock & Restock Management" and its subtitle said it
 * plainly: available is total bought minus quantity sold on Resale orders.
 *
 * That subtraction is the whole point of this module, so it is worth being
 * exact about where each half comes from.
 *
 *   bought  = the sum of resale_stock.quantity for that item
 *   sold    = the sum of order_items.quantity on Resale lines whose order is
 *             not Cancelled and whose line is not archived
 *   available = bought - sold
 *
 * bought is never decremented. The stock table is a ledger of purchases, one row
 * per restock, in the same way the legacy BUY sheet was an append-only log.
 * A sale is recorded on the order, which already happens for every order, and
 * the two are subtracted when the figure is needed. That is the legacy design
 * and it is the safer one: nothing has to be written at the moment of sale, so
 * there is no window in which a failed order save has already quietly reduced
 * the stock. It also means a cancelled or withdrawn order gives the stock back
 * on its own, with no repair step.
 *
 * Rows are grouped by item name rather than by row, because the same garment can
 * legitimately be bought in more than one restock. The name is the join key on
 * both sides, which is what the legacy sheet did with column 22 of ORDERS.
 *
 * The sell price shown is the one on the newest restock of that item, and
 * restocking pre-fills it. That is the legacy behaviour: the sheet was read top
 * to bottom and the last row that mentioned an item set its price, so recording
 * a purchase at a new price is how the price changes.
 *
 * Who may do what follows the database rather than this file: any member may
 * record a restock, and only the Owner may remove one. A restock is a
 * purchase, so the person who did the buying should be able to record it even on
 * a day the Owner is not in. Removing a row is different - it changes what the
 * books say was bought - so that is the Owner's.
 */

window.ANT = window.ANT || {};

window.ANT.resale = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };
  var money = function (v) { return window.ANT.money(v); };

  // The legacy badge cut-offs. Five or fewer is "low", none left is "out".
  var LOW_AT = 5;

  var state = {
    rows: [],
    view: [],
    prices: [],
    search: '',
    form: { item: '', quantity: '1', buy_price: '0', sell_price: '0', buy_date: '', notes: '' },
    loading: false,
    busy: false,
    error: null
  };

  function byId(id) { return document.getElementById(id); }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function round3(n) {
    return Math.round((n + Number.EPSILON) * 1000) / 1000;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
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

  /* The shared figure ----------------------------------------------------- */

  // What has been sold, keyed by item name.
  //
  // The name is the key rather than the stock row id on purpose. A name can
  // have several purchase rows, and the order line records one of their ids, so
  // keying by id would count a sale against one purchase row while the page
  // shows the total for the whole name. The two would then disagree, and the
  // figure that decides whether an item can be sold again would be the wrong one.
  //
  // A line written before resale_item_id existed carries the name in the variant
  // column, which is still written today for export compatibility, so that is
  // used as the fallback.
  function soldByName(stockRows, items, liveOrderIds) {
    var nameById = {};
    stockRows.forEach(function (r) {
      if (r && r.id) nameById[r.id] = text(r.item);
    });

    var sold = {};
    (items || []).forEach(function (it) {
      if (liveOrderIds.indexOf(it.order_id) === -1) return;

      var name = it.resale_item_id ? nameById[it.resale_item_id] : text(it.variant);
      if (!name) return;

      sold[name] = round3((sold[name] || 0) + num(it.quantity));
    });
    return sold;
  }

  // bought minus sold, per item name, ready to display.
  //
  // The price list is passed in rather than read from state, so this can be
  // worked out on its own and checked without a page.
  function buildView(stockRows, sold, prices) {
    var byName = {};
    var order = [];

    (stockRows || []).forEach(function (r) {
      var name = text(r && r.item);
      if (!name) return;

      if (!byName[name]) {
        byName[name] = {
          item: name,
          ids: [],
          bought: 0,
          sold: 0,
          available: 0,
          cost: 0,
          sell_price: 0,
          last_buy_date: '',
          restocks: 0
        };
        order.push(name);
      }

      var g = byName[name];
      g.ids.push(r.id);
      g.bought = round3(g.bought + num(r.quantity));
      g.cost = round2(g.cost + num(r.total_cost));
      g.restocks += 1;

      // Rows arrive oldest first, so the last one seen is the newest restock and
      // its price is the current one.
      g.sell_price = num(r.sell_price);
      if (r.buy_date) g.last_buy_date = r.buy_date;
    });

    var view = order.map(function (name) {
      var g = byName[name];
      g.sold = round3(sold && sold[name] ? sold[name] : 0);
      g.available = round3(g.bought - g.sold);
      return g;
    });

    // A price-list entry with nothing bought still belongs on the page, so the
    // owner can see that "Leggings" is a thing they sell and have none of. The
    // legacy list did exactly this by merging the PRICES sheet into the stock.
    (prices || []).forEach(function (p) {
      var name = text(p.item);
      if (!name || byName[name]) return;
      view.push({
        item: name,
        ids: [],
        bought: 0,
        sold: 0,
        available: 0,
        cost: 0,
        sell_price: num(p.price),
        last_buy_date: '',
        restocks: 0,
        priceOnly: true
      });
    });

    view.sort(function (a, b) {
      return a.item.localeCompare(b.item);
    });
    return view;
  }

  // One place that fetches and works out the stock, so the page and the order
  // screen can never quote different figures for the same item.
  function load() {
    return sb().from('resale_stock')
      .select('id,code,item,quantity,buy_price,sell_price,total_cost,buy_date')
      .order('created_at', true)
      .then(function (stock) {
        if (stock.error) throw new Error(reason(stock));

        var rows = stock.data || [];

        return loadPrices()
          .then(function () { return loadSold(rows); })
          .then(function (sold) { return buildView(rows, sold, state.prices); });
      });
  }

  // Prices are only needed for the items that have never been bought, so a
  // failure here costs a few extra rows on the page and nothing else.
  function loadPrices() {
    return sb().from('prices')
      .select('item,price,group_name')
      .eq('group_name', 'RESALE')
      .eq('status', 'ACTIVE')
      .then(function (res) {
        state.prices = res.error ? [] : (res.data || []);
        return state.prices;
      });
  }

  // The two reads that make up "sold".
  //
  // Resale lines are asked for first because there are far fewer of them than
  // there are orders, so only the handful of orders they belong to are looked up
  // for status. Reading every order id instead would grow without limit as the
  // shop gets busier.
  function loadSold(stockRows) {
    return sb().from('order_items')
      .select('order_id,resale_item_id,variant,quantity')
      .eq('service', 'Resale')
      .is('archived_at', null)
      .then(function (res) {
        if (res.error) {
          // Availability is the number that stops a saree being sold twice, so a
          // stock list without it is not shown as though it were the truth.
          throw new Error('The sold items could not be read: ' + reason(res));
        }

        var items = res.data || [];
        var ids = [];
        items.forEach(function (it) {
          if (ids.indexOf(it.order_id) === -1) ids.push(it.order_id);
        });
        if (!ids.length) return {};

        return liveOrderIds(ids).then(function (live) {
          return soldByName(stockRows, items, live);
        });
      });
  }

  // Cancelled work is not work, so it never left the shelf.
  function liveOrderIds(ids) {
    return sb().from('orders')
      .select('id')
      .in('id', ids)
      .neq('status', 'Cancelled')
      .then(function (res) {
        if (res.error) {
          throw new Error('The orders could not be read: ' + reason(res));
        }
        return (res.data || []).map(function (o) { return o.id; });
      });
  }

  /* Codes ----------------------------------------------------------------- */

  // resale_stock.code is not null and unique, and every restock is its own row,
  // so the number has to be made before the insert. RSL-0001, counted across
  // every restock, the way the legacy buy sheet numbered each purchase.
  function nextCode() {
    return sb().from('resale_stock')
      .select('code')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        var n = 1;
        if (res && !res.error && res.data && res.data.length) {
          var m = /(\d+)\s*$/.exec(res.data[0].code || '');
          if (m) n = parseInt(m[1], 10) + 1;
        }
        return 'RSL-' + String(n).padStart(4, '0');
      });
  }

  function isDuplicate(res) {
    var m = String((res && res.error && res.error.message) || '').toLowerCase();
    return m.indexOf('duplicate') > -1 || m.indexOf('unique') > -1;
  }

  /* View ----------------------------------------------------------------- */

  function mount() {
    return '<div id="resaleView"></div>';
  }

  function paint() {
    var host = byId('resaleView');
    if (!host) return;

    host.innerHTML = head() + tiles() + alert() + listCard() + formCard();
    wire();
  }

  function head() {
    return '<div class="page-head"><div>' +
      '<h1 class="page-head-title">Resale Stock</h1>' +
      '<p class="page-head-sub">Available is what has been bought minus what has ' +
      'been sold on Resale orders. A sale is recorded on the order, so cancelling ' +
      'or withdrawing an order puts the stock back by itself.</p>' +
      '</div></div>' +
      (state.error ? '<div class="ord-err"><p class="ui-card-sub">' + esc(state.error) + '</p></div>' : '');
  }

  function counts() {
    var c = { in: 0, low: 0, out: 0 };
    state.view.forEach(function (r) {
      if (r.available <= 0) c.out += 1;
      else if (r.available <= LOW_AT) c.low += 1;
      else c.in += 1;
    });
    return c;
  }

  function tile(label, value, foot, kind) {
    return '<div class="stat' + (kind ? ' stat-' + kind : '') + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(value) + '</div>' +
      '<div class="stat-foot">' + esc(foot) + '</div>' +
      '</div>';
  }

  function tiles() {
    var c = counts();
    return '<div class="dashboard-grid">' +
      tile('Items', String(state.view.length), 'Tracked or listed for sale') +
      tile('In stock', String(c.in), 'More than ' + LOW_AT + ' left', 'ok') +
      tile('Low stock', String(c.low), LOW_AT + ' or fewer left', 'warn') +
      tile('Out of stock', String(c.out), 'Nothing left to sell', 'bad') +
      '</div>';
  }

  // The one thing on this page that needs a decision, so it is said in words
  // rather than left to be worked out from two coloured badges.
  function alert() {
    var low = [];
    var out = [];
    state.view.forEach(function (r) {
      if (r.available <= 0) out.push(r.item);
      else if (r.available <= LOW_AT) low.push(r.item);
    });
    if (!low.length && !out.length) return '';

    var parts = [];
    if (out.length) parts.push(out.length + ' out of stock');
    if (low.length) parts.push(low.length + ' low stock');

    return '<div class="resale-alert">' +
      '<strong>Restock needed:</strong> ' + esc(parts.join(', ') + '.') + ' ' +
      esc(low.concat(out).slice(0, 6).join(', ')) +
      (low.length + out.length > 6 ? ' and others' : '') +
      '</div>';
  }

  function listCard() {
    return '<div class="ui-card"><h2 class="ui-card-title">Stock</h2>' +
      '<div class="ui-field"><label class="ui-label" for="resaleSearch">Search item</label>' +
      '<input class="ui-input" id="resaleSearch" value="' + esc(state.search) + '" ' +
      'placeholder="Search by item name"></div>' +
      // Only what is inside this box is redrawn when the search changes, so the
      // box being typed in keeps the caret and the focus.
      '<div id="resaleRows">' + listBody() + '</div>' +
      '</div>';
  }

  function listBody() {
    if (state.loading) {
      return '<div class="empty"><p class="empty-text">Loading&hellip;</p></div>';
    }
    if (!shown().length) {
      return '<div class="empty"><div class="empty-title">' +
        (state.view.length ? 'Nothing matches' : 'No items yet') + '</div>' +
        '<p class="empty-text">' +
        (state.view.length
          ? 'No item name matches that search.'
          : 'No resale items. Record the first purchase with the restock form below.') +
        '</p></div>';
    }
    return '<table class="ui-table"><thead><tr>' +
      '<th>Item</th><th class="num">Bought</th><th class="num">Sold</th>' +
      '<th class="num">Available</th><th class="num">Sell price</th>' +
      '<th>Last buy</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' + shown().map(row).join('') + '</tbody></table>';
  }

  function shown() {
    var q = text(state.search).toLowerCase();
    if (!q) return state.view;
    return state.view.filter(function (r) {
      return r.item.toLowerCase().indexOf(q) > -1;
    });
  }

  function row(r) {
    var owner = isOwner();
    return '<tr' + (r.priceOnly ? ' class="resale-price-only"' : '') + '>' +
      '<td><span class="ord-sub-strong">' + esc(r.item) + '</span>' +
        (r.restocks > 1
          ? ' <span class="chip chip-muted">' + r.restocks + ' restocks</span>'
          : '') +
        (r.priceOnly ? ' <span class="chip chip-info">Price list</span>' : '') + '</td>' +
      '<td class="num">' + qty(r.bought) + '</td>' +
      '<td class="num">' + qty(r.sold) + '</td>' +
      // A negative figure is shown as it is rather than hidden at zero. It means
      // more was sold than was ever recorded as bought, and that is worth seeing.
      '<td class="num"><strong>' + qty(r.available) + '</strong></td>' +
      '<td class="num">' + money(r.sell_price) + '</td>' +
      '<td>' + esc(r.last_buy_date ? dateLabel(r.last_buy_date) : '-') + '</td>' +
      '<td>' + badge(r.available) + '</td>' +
      '<td class="ord-row-actions">' +
      '<button class="btn btn-sm btn-secondary" data-resale-restock="' + esc(r.item) + '">Restock</button>' +
      (owner && r.ids.length
        ? ' <button class="btn btn-sm btn-secondary" data-resale-drop="' + esc(r.ids[0]) + '"' +
          ' data-resale-item="' + esc(r.item) + '">Remove</button>'
        : '') +
      '</td></tr>';
  }

  function qty(n) {
    var v = round3(num(n));
    return String(v);
  }

  function badge(available) {
    if (available <= 0) return '<span class="chip chip-muted">Out of stock</span>';
    if (available <= LOW_AT) return '<span class="chip chip-warn">Low stock</span>';
    return '<span class="chip chip-success">In stock</span>';
  }

  function formCard() {
    return '<div class="ui-card" id="resaleFormCard">' +
      '<h2 class="ui-card-title">Restock item</h2>' +
      '<p class="ui-card-sub">A restock is recorded as a new line in the stock ' +
      'ledger. The sell price here becomes the price the order screen offers.</p>' +
      '<div class="pay-grid">' +
      textField('resaleItem', 'Item', state.form.item, 'Type or pick an item') +
      qtyField('resaleQty', 'Quantity', state.form.quantity) +
      moneyField('resaleBuy', 'Buy price', state.form.buy_price) +
      moneyField('resaleSell', 'Sell price', state.form.sell_price) +
      '<div class="ui-field"><label class="ui-label" for="resaleDate">Buy date</label>' +
        '<input class="ui-input" id="resaleDate" type="date" value="' + esc(state.form.buy_date) + '"></div>' +
      '<div class="ui-field"><label class="ui-label" for="resaleNotes">Notes</label>' +
        '<input class="ui-input" id="resaleNotes" value="' + esc(state.form.notes) + '" placeholder="optional"></div>' +
      '</div>' +
      '<div class="ord-row-actions">' +
      '<button class="btn btn-primary" id="resaleSave"' + (state.busy ? ' disabled' : '') + '>' +
        (state.busy ? 'Saving&hellip;' : 'Save restock') + '</button>' +
      '</div>' +
      '<datalist id="resaleItems">' + state.view.map(function (r) {
        return '<option value="' + esc(r.item) + '"></option>';
      }).join('') + '</datalist>' +
      '</div>';
  }

  function textField(id, label, value, placeholder) {
    return '<div class="ui-field"><label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" list="resaleItems" value="' + esc(value) + '" ' +
      'placeholder="' + esc(placeholder) + '"></div>';
  }

  function qtyField(id, label, value) {
    return '<div class="ui-field"><label class="ui-label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="ui-input" id="' + id + '" inputmode="decimal" value="' + esc(value) + '"></div>';
  }

  function moneyField(id, label, value) {
    return qtyField(id, label, value);
  }

  /* Actions -------------------------------------------------------------- */

  // "Restock" on a row fills the form in, which is the same helper the legacy
  // page used: the item and its current sell price, with the quantity back to 1
  // so the same number is not bought twice by a stray keystroke.
  function restockThis(item) {
    var found = null;
    state.view.forEach(function (r) {
      if (r.item === item) found = r;
    });

    state.form.item = item;
    state.form.quantity = '1';
    state.form.buy_price = '0';
    state.form.sell_price = found ? String(num(found.sell_price)) : '0';
    state.form.notes = '';
    state.form.buy_date = today();
    paint();

    var box = byId('resaleItem');
    if (box) {
      box.focus();
      if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    }
  }

  // A purchase row is only ever removed, never edited, and only by the Owner.
  // The row is named in the prompt because a mis-click here reduces what the
  // books say was bought, and a number going quietly down is the kind of thing
  // that is only noticed at stocktake.
  function dropRow(id, item) {
    if (!isOwner()) {
      toast('Only the Owner can remove a stock line.', 'error');
      return;
    }
    if (!window.confirm('Remove the most recent purchase of "' + item + '" from the stock ledger?')) {
      return;
    }

    sb().from('resale_stock')
      .remove()
      .eq('id', id)
      .then(function (res) {
        if (res.error) {
          toast('The stock line could not be removed: ' + reason(res), 'error');
          return;
        }
        toast('Purchase of ' + item + ' removed.', 'success');
        return refresh();
      });
  }

  function save() {
    var item = text(state.form.item);
    var quantity = num(state.form.quantity);
    var buyPrice = num(state.form.buy_price);
    var sellPrice = num(state.form.sell_price);

    // The same three refusals the legacy stkRestock made, in the same words,
    // because they are the ones that stop nonsense reaching the ledger.
    if (!item) {
      toast('Enter an item name.', 'error');
      focus('resaleItem');
      return;
    }
    if (!(quantity > 0)) {
      toast('Quantity must be more than 0.', 'error');
      focus('resaleQty');
      return;
    }
    if (sellPrice < 0) {
      toast('Sell price cannot be negative.', 'error');
      focus('resaleSell');
      return;
    }
    // The legacy form had no minimum on the buy price. A negative one would make
    // total_cost negative and quietly understate what the stock cost, so it is
    // refused here rather than stored.
    if (buyPrice < 0) {
      toast('Buy price cannot be negative.', 'error');
      focus('resaleBuy');
      return;
    }

    state.busy = true;
    paint();

    insert(item, round3(quantity), round2(buyPrice), round2(sellPrice), false)
      .then(function (result) {
        state.busy = false;
        if (!result) return;
        if (result.failed) {
          toast(result.message, 'error');
          paint();
          return;
        }

        // The quantity goes back to 1 and the prices are cleared, so the next
        // purchase is not made with the last one's numbers still on screen. The
        // item is kept, because restocking the same thing twice is the common
        // case and retyping it would be the annoying part.
        state.form.quantity = '1';
        state.form.buy_price = '0';
        state.form.sell_price = '0';
        state.form.notes = '';
        state.form.buy_date = today();
        toast('Restocked ' + item + ' (+' + qty(quantity) + ' units).', 'success');
        return refresh();
      });
  }

  // Two people restocking at once can read the same next number, so a clash on
  // the unique code is retried once rather than reported as a failure the user
  // cannot do anything about.
  function insert(item, quantity, buyPrice, sellPrice, retried) {
    return nextCode().then(function (code) {
      return sb().from('resale_stock')
        .insert({
          code: code,
          item: item,
          quantity: quantity,
          buy_price: buyPrice,
          sell_price: sellPrice,
          // The legacy sheet stored qty * buy price on the row, and the column is
          // here for the same reason: what this purchase cost, kept with the
          // purchase rather than worked out later from a price that has since
          // changed.
          total_cost: round2(quantity * buyPrice),
          buy_date: state.form.buy_date || today(),
          notes: text(state.form.notes)
        })
        .single()
        .then(function (res) {
          if (res.error || !res.data) {
            if (!retried && isDuplicate(res)) {
              return insert(item, quantity, buyPrice, sellPrice, true);
            }
            return { failed: true, message: 'The restock was not saved: ' + reason(res) };
          }
          return { message: 'ok' };
        });
    }).catch(function (e) {
      return { failed: true, message: 'The restock was not saved: ' + (e && e.message) };
    });
  }

  function focus(id) {
    var el = byId(id);
    if (el) el.focus();
  }

  function refresh() {
    state.loading = true;
    state.error = null;
    return load()
      .then(function (view) {
        state.view = view;
        state.loading = false;
        paint();
      })
      .catch(function (e) {
        // Availability decides what may be sold, so a stock page that cannot
        // work it out says so rather than showing bought numbers as though they
        // were what is on the shelf.
        state.loading = false;
        state.view = [];
        state.error = (e && e.message) || 'The stock could not be loaded.';
        paint();
      });
  }

  /* Wiring --------------------------------------------------------------- */

  function wire() {
    var search = byId('resaleSearch');
    if (search) {
      search.addEventListener('input', function () {
        state.search = search.value;
        // Only the table is redrawn, so the caret in the search box stays put
        // while the rows change underneath it.
        redrawList();
      });
    }

    bind('resaleItem', 'item');
    bind('resaleQty', 'quantity');
    bind('resaleBuy', 'buy_price');
    bind('resaleSell', 'sell_price');
    bind('resaleDate', 'buy_date');
    bind('resaleNotes', 'notes');

    each('[data-resale-restock]', function (b) {
      b.addEventListener('click', function () {
        restockThis(b.getAttribute('data-resale-restock'));
      });
    });

    each('[data-resale-drop]', function (b) {
      b.addEventListener('click', function () {
        dropRow(b.getAttribute('data-resale-drop'), b.getAttribute('data-resale-item'));
      });
    });

    var save$ = byId('resaleSave');
    if (save$) save$.addEventListener('click', save);
  }

  function bind(id, key) {
    var el = byId(id);
    if (!el) return;
    el.addEventListener('input', function () { state.form[key] = el.value; });
    el.addEventListener('change', function () { state.form[key] = el.value; });
  }

  // Redraws the table only. The search box is left alone, so the caret stays
  // where it is while the rows change underneath, and the buttons inside the
  // new table get their handlers without the page being wired up twice.
  function redrawList() {
    var rows = byId('resaleRows');
    if (rows) {
      rows.innerHTML = listBody();
      each('#resaleRows [data-resale-restock]', function (b) {
        b.addEventListener('click', function () {
          restockThis(b.getAttribute('data-resale-restock'));
        });
      });
      each('#resaleRows [data-resale-drop]', function (b) {
        b.addEventListener('click', function () {
          dropRow(b.getAttribute('data-resale-drop'), b.getAttribute('data-resale-item'));
        });
      });
    }
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  function render() {
    state.rows = [];
    state.view = [];
    state.prices = [];
    state.search = '';
    state.form = {
      item: '', quantity: '1', buy_price: '0', sell_price: '0',
      buy_date: today(), notes: ''
    };
    state.loading = true;
    state.busy = false;
    state.error = null;
    refresh();
  }

  return {
    mount: mount,
    render: render,
    // Exported so the order screen quotes the same figure as this page. Two
    // definitions of "available" would eventually disagree, and the one on the
    // order screen is the one that decides whether a garment can be sold twice.
    load: load,
    buildView: buildView,
    soldByName: soldByName
  };
})();

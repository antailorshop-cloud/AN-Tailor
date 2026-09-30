/* AN TAILOR - Settings: dress types and prices.
 *
 * These two tables are master data. Every order line needs a dress type and a
 * price, so nothing downstream can be created until these hold real values.
 *
 * Read access is open to every signed-in user, because staff must be able to
 * see a price while taking an order. Writes are the owner's alone, and that is
 * enforced by the database policies `prices_write_owner` and
 * `dress_types_write_owner`, not by this file. A staff member who finds a way
 * to call these functions anyway is refused by Postgres.
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

  var state = {
    tab: 'dress',
    search: '',
    dressRows: [],
    priceRows: [],
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

    return Promise.all([d, p]).then(function (both) {
      state.loading = false;

      var first = both[0].error ? both[0] : (both[1].error ? both[1] : null);
      if (first) {
        state.error = first.message;
      } else {
        state.error = null;
        state.dressRows = both[0].data || [];
        state.priceRows = both[1].data || [];
      }
      paint();
    });
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
        '<p class="page-head-sub">Dress types and prices. Staff can read these; only the Owner can change them.</p>' +
      '</div>' +
    '</div>';
  }

  function tabs() {
    return '<div class="set-tabs">' +
      '<button class="set-tab' + (state.tab === 'dress' ? ' is-active' : '') + '" data-set-tab="dress">Dress types</button>' +
      '<button class="set-tab' + (state.tab === 'price' ? ' is-active' : '') + '" data-set-tab="price">Prices</button>' +
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

    return head + '<div class="table-wrap"><table class="ui-table">' +
      '<thead><tr><th>Category</th><th>Dress type</th><th></th></tr></thead>' +
      '<tbody>' + rows.map(function (r) {
        return '<tr>' +
          '<td><span class="chip">' + esc(r.category) + '</span></td>' +
          '<td class="cust-name">' + esc(r.dress_type) + '</td>' +
          '<td class="cust-actions">' +
            (isOwner()
              ? '<button class="btn btn-sm btn-secondary" data-set-edit="' + esc(r.id) + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger" data-set-del="' + esc(r.id) + '">Delete</button>'
              : '') +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody>' +
    '</table></div>';
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

    return head + '<div class="table-wrap"><table class="ui-table">' +
      '<thead><tr><th>Group</th><th>Item</th><th>Option</th><th class="num">Price</th><th></th></tr></thead>' +
      '<tbody>' + rows.map(function (r) {
        return '<tr>' +
          '<td><span class="chip">' + esc(r.group_name) + '</span></td>' +
          '<td class="cust-name">' + esc(r.item) + '</td>' +
          '<td>' + esc(r.option || '—') + '</td>' +
          '<td class="num">' + esc(money(r.price)) +
            (Number(r.extra_charge || 0) !== 0
              ? ' <span class="cust-count">+ ' + esc(money(r.extra_charge)) + '</span>'
              : '') +
          '</td>' +
          '<td class="cust-actions">' +
            (isOwner()
              ? '<button class="btn btn-sm btn-secondary" data-set-edit="' + esc(r.id) + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger" data-set-del="' + esc(r.id) + '">Delete</button>'
              : '') +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody>' +
    '</table></div>';
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
      return sb().from('dress_types')
        .insert(values)
        .select('id')
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
        .select('id')
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
    if (!window.confirm('Delete this ' + (kind === 'dress' ? 'dress type' : 'price') + '?')) return;

    var table = kind === 'dress' ? 'dress_types' : 'prices';

    sb().from(table)
      .delete()
      .eq('id', id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        if (!res.data || res.data.length === 0) {
          return toast('Only the Owner can delete this.', 'error');
        }
        toast('Deleted', 'success');
        load();
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
  }

  return {
    mount: function () {
      return '<div id="settingsView"></div>';
    },

    render: function () {
      state.tab = 'dress';
      state.search = '';
      state.form = null;
      paint();
      load();
    }
  };
})();

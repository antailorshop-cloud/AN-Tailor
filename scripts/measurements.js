/* AN TAILOR - Measurements.
 *
 * A measurement is a snapshot, not a live value. A customer's chest today is not
 * the chest they had when the shirt was cut, so every save is a new row and the
 * previous one is kept. That is why `values` is jsonb keyed by field name: the
 * set of fields differs per dress type, and adding a field to one garment must
 * not require a migration.
 *
 * The field lists below are taken from the legacy Measurements.html, so the shop
 * sees the same labels it always has. Changing a list here changes what the
 * tailor is offered; existing rows keep whatever keys they were saved with,
 * because a missing key simply renders blank.
 */

window.ANT = window.ANT || {};

window.ANT.measurements = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };

  // Per-dress-type measurement fields, verbatim from the legacy system.
  var FIELDS = {
    'Shirt': ['Full Length', 'Shoulder', 'Chest', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Cuff Round', 'Neck Round', 'Armhole', 'Front Length', 'Back Length'],
    'T-Shirt': ['Full Length', 'Shoulder', 'Chest', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Neck Round', 'Armhole'],
    'Kurta': ['Full Length', 'Shoulder', 'Chest', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Neck Round', 'Armhole', 'Side Slit Length'],
    'Pant / Trouser': ['Full Length', 'Waist', 'Hip / Seat', 'Thigh Round', 'Knee Round', 'Calf Round', 'Bottom Round', 'Crotch Length', 'Inseam Length', 'Outseam Length'],
    'Blouse': ['Blouse Length', 'Shoulder', 'Bust', 'Under Bust', 'Waist', 'Armhole', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Neck Front', 'Neck Back', 'Front Neck Depth', 'Back Neck Depth'],
    'Churidar / Salwar': ['Top Length', 'Shoulder', 'Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Armhole', 'Salwar Length', 'Salwar Waist', 'Salwar Hip', 'Salwar Bottom'],
    'Kurti': ['Kurti Length', 'Shoulder', 'Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Armhole', 'Neck Front', 'Neck Back'],
    'Salwar Kameez': ['Kameez Length', 'Shoulder', 'Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Armhole', 'Salwar Length', 'Salwar Waist', 'Salwar Hip'],
    'Anarkali': ['Full Length', 'Shoulder', 'Bust', 'Under Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Armhole', 'Neck Front', 'Neck Back'],
    'Lehenga Blouse': ['Blouse Length', 'Shoulder', 'Bust', 'Under Bust', 'Waist', 'Armhole', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Neck Front', 'Neck Back'],
    'Pant': ['Pant Length', 'Waist', 'Hip / Seat', 'Thigh Round', 'Knee Round', 'Calf Round', 'Bottom Round', 'Crotch Length', 'Inseam Length', 'Outseam Length'],
    'Palazzo': ['Palazzo Length', 'Waist', 'Hip / Seat', 'Thigh Round', 'Bottom Round', 'Crotch Length'],
    'Maxi': ['Maxi Length', 'Shoulder', 'Bust', 'Under Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Armhole', 'Neck Front', 'Neck Back'],
    'Nighty': ['Nighty Length', 'Shoulder', 'Bust', 'Waist', 'Hip / Seat', 'Sleeve Length', 'Sleeve Round', 'Bicep Round', 'Armhole', 'Neck Front', 'Neck Back']
  };

  // Gents and Ladies, matching dress_types.category.
  var GENTS = ['Shirt', 'T-Shirt', 'Kurta', 'Pant / Trouser', 'Dhoti', 'Waistcoat', 'Sherwani', 'Safari Suit', 'Suit / Blazer'];
  var LADIES = ['Blouse', 'Churidar / Salwar', 'Kurti', 'Salwar Kameez', 'Anarkali', 'Lehenga Blouse', 'Pant', 'Palazzo', 'Maxi', 'Nighty'];

  var state = {
    search: '',
    customers: [],
    customer: null,      // the chosen customer row
    customerQuery: '',
    dressType: '',
    history: [],
    form: null,          // null = closed, 'new', or a measurement row
    loading: false,
    error: null
  };

  var custTimer = null;

  function me() {
    return window.ANT.auth.current() || {};
  }

  function isOwner() {
    return me().role === 'owner';
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function fieldsFor(dressType) {
    return FIELDS[dressType] || [];
  }

  function dateLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* Loading ------------------------------------------------------------ */

  function loadHistory() {
    if (!state.customer) {
      state.history = [];
      return Promise.resolve();
    }

    state.loading = true;
    paint();

    return sb().from('measurements')
      .select('*')
      .eq('customer_id', state.customer.id)
      .order('created_at', false)
      .then(function (res) {
        state.loading = false;
        if (res.error) {
          state.error = res.error.message;
          state.history = [];
        } else {
          state.error = null;
          state.history = res.data || [];
        }
        paint();
      });
  }

  function searchCustomers(term) {
    var t = String(term || '').trim();
    if (t.length < 1) return Promise.resolve();

    var q = sb().from('customers').select('id,code,name,mobile');
    if (state.search) {
      var clean = '*' + t.replace(/[*%,()]/g, ' ') + '*';
      q = q.or('name.ilike.' + clean + ',mobile.ilike.' + clean + ',code.ilike.' + clean);
    }
    q = q.order('name', true).limit(8);

    return q.then(function (res) {
      if (res.error) {
        state.customers = [];
        return;
      }
      state.customers = res.data || [];
      paint();
    });
  }

  /* View --------------------------------------------------------------- */

  function paint() {
    var host = byId('measurementsView');
    if (!host) return;
    host.innerHTML = pageHead() + picker() + (state.customer ? detail() : hint());
    wire();
  }

  function pageHead() {
    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">Measurements</h1>' +
        '<p class="page-head-sub">Each save is kept as a new record, so the measurements an order was cut from are never lost.</p>' +
      '</div>' +
    '</div>';
  }

  function hint() {
    return '<div class="ui-card"><div class="empty">' +
      '<div class="empty-title">Choose a customer</div>' +
      '<p class="empty-text">Search above by name, mobile or code to open their measurements.</p>' +
    '</div></div>';
  }

  function picker() {
    var results = '';

    if (state.customers.length) {
      results = '<div class="msr-results" id="msrResults">' +
        state.customers.map(function (c) {
          return '<button class="msr-result" data-msr-cust="' + esc(c.id) + '">' +
            '<span class="msr-result-name">' + esc(c.name) + '</span>' +
            '<span class="msr-result-meta">' + esc(c.code) + (c.mobile ? ' · ' + esc(c.mobile) : '') + '</span>' +
          '</button>';
        }).join('') +
      '</div>';
    }

    return '<div class="ui-card">' +
      '<label class="ui-label" for="msrSearch">Customer</label>' +
      '<input class="ui-input" id="msrSearch" type="search" placeholder="Search name, mobile or code" ' +
        'value="' + esc(state.customerQuery) + '" autocomplete="off" spellcheck="false">' +
      results +
    '</div>';
  }

  function detail() {
    var c = state.customer;

    return '<div class="msr-cust">' +
      '<div>' +
        '<div class="msr-cust-name">' + esc(c.name) + '</div>' +
        '<div class="msr-cust-meta">' + esc(c.code) + (c.mobile ? ' · ' + esc(c.mobile) : '') + '</div>' +
      '</div>' +
      '<button class="btn btn-secondary" id="msrChange">Change customer</button>' +
    '</div>' +
    (state.error ? errorCard() : '') +
    (state.form ? formHtml() : newButton()) +
    historyCard();
  }

  function errorCard() {
    return '<div class="ui-card"><div class="empty">' +
      '<div class="empty-title">Could not load measurements</div>' +
      '<p class="empty-text">' + esc(state.error) + '</p>' +
    '</div></div>';
  }

  function newButton() {
    if (state.loading) return '';
    return '<div class="msr-new">' +
      '<button class="btn btn-primary" id="msrNew">+ New measurement</button>' +
    '</div>';
  }

  function historyCard() {
    var rows = state.history;

    if (state.loading && !rows.length) {
      return '<div class="ui-card"><div class="empty"><div class="empty-title">Loading...</div></div></div>';
    }

    if (!rows.length) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">No measurements yet</div>' +
        '<p class="empty-text">Record the first one using the button above.</p>' +
      '</div></div>';
    }

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">History</h2>' +
      '<p class="ui-card-sub">Newest first. Every row is kept, because an order was cut from one of these.</p>' +
      rows.map(historyBlock).join('') +
    '</div>';
  }

  function historyBlock(m) {
    var values = m.values || {};
    var keys = Object.keys(values);
    var filled = keys.filter(function (k) {
      return String(values[k] == null ? '' : values[k]).trim() !== '';
    });

    return '<div class="msr-block">' +
      '<div class="msr-block-head">' +
        '<div>' +
          '<span class="msr-block-dress">' + esc(m.dress_type) + '</span>' +
          '<span class="msr-block-code">' + esc(m.code) + '</span>' +
        '</div>' +
        '<div class="msr-block-actions">' +
          '<span class="msr-block-date">' + esc(dateLabel(m.created_at)) + '</span>' +
          '<button class="btn btn-sm btn-secondary" data-msr-copy="' + esc(m.id) + '">Copy to new</button>' +
          (isOwner()
            ? '<button class="btn btn-sm btn-danger" data-msr-del="' + esc(m.id) + '">Delete</button>'
            : '') +
        '</div>' +
      '</div>' +
      (filled.length
        ? '<div class="msr-grid">' + filled.map(function (k) {
            return '<div class="msr-cell">' +
              '<span class="msr-cell-label">' + esc(k) + '</span>' +
              '<span class="msr-cell-value">' + esc(values[k]) + '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="msr-block-empty">No values recorded.</p>') +
      (m.notes ? '<p class="msr-notes">' + esc(m.notes) + '</p>' : '') +
    '</div>';
  }

  /* Form --------------------------------------------------------------- */

  function dressOptions() {
    var opts = ['<option value="">Choose a dress type</option>'];
    [['Gents', GENTS], ['Ladies', LADIES]].forEach(function (pair) {
      opts.push('<optgroup label="' + esc(pair[0]) + '">');
      pair[1].forEach(function (t) {
        // A type with no field list would render an empty form, so it is still
        // offered but the tailor sees "no fields defined" rather than a blank
        // grid they might think is a fault.
        opts.push('<option value="' + esc(t) + '"' + (t === state.dressType ? ' selected' : '') + '>' + esc(t) + '</option>');
      });
      opts.push('</optgroup>');
    });
    return opts.join('');
  }

  function formHtml() {
    var editing = state.form !== 'new';
    var row = editing ? findRow(state.form) : null;
    var values = (row && row.values) || {};
    var notes = (row && row.notes) || '';
    var dress = (row && row.dress_type) || state.dressType || '';
    var fields = fieldsFor(dress);

    var grid;

    if (!dress) {
      grid = '<p class="ui-hint">Choose a dress type to see its measurement fields.</p>';
    } else if (!fields.length) {
      grid = '<p class="ui-hint">No fields are defined for ' + esc(dress) + '. Add values under Notes instead.</p>';
    } else {
      grid = '<div class="msr-form-grid">' + fields.map(function (f) {
        var v = values[f];
        // The id is derived from the label so clicking the label text focuses
        // the box. Without it the label points at nothing and tapping the name
        // on a phone does nothing, which reads as a field that cannot be edited.
        var fid = 'msrF' + f.replace(/[^a-z0-9]/gi, '');
        return '<div class="ui-field">' +
          '<label class="ui-label" for="' + esc(fid) + '">' + esc(f) + '</label>' +
          '<input class="ui-input" id="' + esc(fid) + '" data-msr-field="' + esc(f) + '" ' +
            'type="text" value="' + esc(v === undefined || v === null ? '' : v) + '" autocomplete="off">' +
        '</div>';
      }).join('') + '</div>';
    }

    return '<div class="ui-card cust-form" id="msrFormCard">' +
      '<h2 class="ui-card-title">' + (editing ? 'Edit measurement' : 'New measurement') + '</h2>' +
      '<p class="ui-card-sub">' + (editing
        ? 'Editing in place. Save a new measurement instead if the customer has been measured again since.'
        : 'This adds a new record. Nothing is overwritten.') + '</p>' +
      '<form id="msrForm" novalidate>' +
        '<div class="form-grid">' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="msrDress">Dress type</label>' +
            '<select class="ui-input" id="msrDress"' + (editing ? ' disabled' : '') + '>' + dressOptions() + '</select>' +
            (editing ? '<p class="ui-hint">The dress type cannot be changed on a saved record.</p>' : '') +
          '</div>' +
        '</div>' +
        grid +
        '<div class="ui-field" style="margin-top:var(--gap-sm)">' +
          '<label class="ui-label" for="msrNotes">Notes / extra requirements</label>' +
          '<textarea class="ui-textarea" id="msrNotes" placeholder="Fabric, style, anything the cutter should know">' + esc(notes) + '</textarea>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">Save measurement</button>' +
          '<button type="button" class="btn btn-secondary" id="msrCancel">Cancel</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function findRow(id) {
    var found = state.history.filter(function (r) { return r.id === id; })[0];
    return found || null;
  }

  function collectValues() {
    var out = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-field]'), function (input) {
      var name = input.getAttribute('data-msr-field');
      var v = input.value.trim();
      if (v !== '') out[name] = v;
    });
    return out;
  }

  function save() {
    var editing = state.form !== 'new';
    var dressEl = byId('msrDress');
    var dress = editing ? (findRow(state.form) || {}).dress_type : (dressEl ? dressEl.value : '');
    var values = collectValues();
    var notesEl = byId('msrNotes');

    if (!dress) {
      toast('Choose a dress type', 'error');
      return;
    }

    var keys = Object.keys(values);
    if (!keys.length && !(notesEl && notesEl.value.trim())) {
      toast('Enter at least one measurement or a note', 'error');
      return;
    }

    var payload = { dress_type: dress, values: values, notes: notesEl ? notesEl.value.trim() : '' };
    var work;

    if (editing) {
      work = sb().from('measurements')
        .update(payload)
        .eq('id', state.form)
        .select('id')
        .then(guardEmpty);
    } else {
      work = insertMeasurement(payload, 0);
    }

    work.then(function (res) {
      if (res.error) {
        toast(res.error.message, 'error');
        return;
      }
      state.form = null;
      state.dressType = '';
      toast('Measurement saved', 'success');
      loadHistory();
    });
  }

  function guardEmpty(res) {
    if (res.error) return res;
    if (!res.data || res.data.length === 0) {
      return { error: { message: 'That measurement could not be changed. Staff may only edit their own.' } };
    }
    return res;
  }

  function insertMeasurement(payload, attempt) {
    return nextCode().then(function (code) {
      if (code === null) {
        return { error: { message: 'Could not work out a new code. Try again.' } };
      }
      return sb().from('measurements')
        .insert({
          code: code,
          customer_id: state.customer.id,
          category: categoryFor(payload.dress_type),
          dress_type: payload.dress_type,
          values: payload.values,
          notes: payload.notes
        })
        .single()
        .then(function (res) {
          if (res.error && res.error.status === 409 && attempt < 3) {
            return insertMeasurement(payload, attempt + 1);
          }
          return res;
        });
    });
  }

  function categoryFor(dress) {
    if (GENTS.indexOf(dress) !== -1) return 'Gents';
    if (LADIES.indexOf(dress) !== -1) return 'Ladies';
    return '';
  }

  function nextCode() {
    return sb().from('measurements')
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
        return 'M' + String(n).padStart(4, '0');
      });
  }

  function remove(id) {
    if (!window.confirm('Delete this measurement? This cannot be undone.')) return;

    sb().from('measurements')
      .delete()
      .eq('id', id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        if (!res.data || res.data.length === 0) {
          return toast('Could not delete. Only the Owner can remove a measurement.', 'error');
        }
        toast('Measurement deleted', 'success');
        loadHistory();
      });
  }

  /* Events ------------------------------------------------------------- */

  function wire() {
    var search = byId('msrSearch');
    if (search) {
      search.addEventListener('input', function (e) {
        state.customerQuery = e.target.value;
        if (custTimer) window.clearTimeout(custTimer);
        custTimer = window.setTimeout(function () {
          searchCustomers(state.customerQuery).then(function () {
            var again = byId('msrSearch');
            if (again) {
              again.value = state.customerQuery;
              again.focus();
              try { again.setSelectionRange(state.customerQuery.length, state.customerQuery.length); } catch (err) {}
            }
          });
        }, 260);
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-cust]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-msr-cust');
        var found = state.customers.filter(function (c) { return c.id === id; })[0];
        if (!found) return;
        state.customer = found;
        state.customerQuery = found.name;
        state.customers = [];
        state.form = null;
        state.dressType = '';
        paint();
        loadHistory();
      });
    });

    var change = byId('msrChange');
    if (change) {
      change.addEventListener('click', function () {
        state.customer = null;
        state.history = [];
        state.form = null;
        state.customerQuery = '';
        state.customers = [];
        paint();
      });
    }

    var add = byId('msrNew');
    if (add) {
      add.addEventListener('click', function () {
        state.form = 'new';
        paint();
        var dress = byId('msrDress');
        if (dress) dress.focus();
      });
    }

    var cancel = byId('msrCancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        state.form = null;
        paint();
      });
    }

    var form = byId('msrForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        save();
      });
    }

    // Switching dress type rebuilds the field grid, so unsaved input on the
    // previous set is dropped. The type is the thing being changed, not a
    // mistake worth preserving across a different garment.
    var dressEl = byId('msrDress');
    if (dressEl) {
      dressEl.addEventListener('change', function () {
        state.dressType = dressEl.value;
        paint();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-copy]'), function (btn) {
      btn.addEventListener('click', function () {
        var row = findRow(btn.getAttribute('data-msr-copy'));
        if (!row) return;
        state.dressType = row.dress_type;
        state.form = 'new';
        paint();
        // Pre-fill from the copied row: the common case is a repeat order for
        // the same garment with a few numbers changed.
        var inputs = document.querySelectorAll('[data-msr-field]');
        Array.prototype.forEach.call(inputs, function (input) {
          var name = input.getAttribute('data-msr-field');
          var v = (row.values || {})[name];
          input.value = v === undefined || v === null ? '' : v;
        });
        var notes = byId('msrNotes');
        if (notes) notes.value = row.notes || '';
        toast('Copied from ' + row.code + '. Adjust and save.', 'success');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-del]'), function (btn) {
      btn.addEventListener('click', function () {
        remove(btn.getAttribute('data-msr-del'));
      });
    });
  }

  return {
    mount: function () {
      return '<div id="measurementsView"></div>';
    },

    render: function () {
      state.search = '';
      state.customerQuery = '';
      state.customers = [];
      state.customer = null;
      state.history = [];
      state.form = null;
      state.dressType = '';
      paint();
    }
  };
})();

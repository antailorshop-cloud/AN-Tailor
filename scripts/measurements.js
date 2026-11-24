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
    history: [],         // measurements of the chosen customer
    allHistory: [],      // measurements across every customer, for the default view
    allCustomers: [],    // used to label the global list with a customer name
    allLoading: false,
    allError: null,
    form: null,          // null = closed, 'new', or a measurement row
    loading: false,
    error: null
  };

  // A customer handed over by another screen, consumed by render(). Options can
  // carry a dress type and ask that a saved measurement be put back on an order.
  var pendingCustomer = null;
  var pendingOptions = null;
  var returnToOrder = false;

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
    // With no customer chosen the page shows every measurement, so the same
    // reload call is used after a delete made from the global list.
    if (!state.customer) return loadAll();

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

  /* The default view lists all measurements, newest first. Rows are paged so a
   * busy shop still sees older records, and customers are fetched separately so
   * a failed name lookup can never hide the measurements themselves. */
  function loadAll() {
    state.allLoading = true;
    state.allError = null;
    paint();

    return Promise.all([loadAllCustomers(), loadAllRows()]).then(function (result) {
      state.allCustomers = result[0];
      state.allHistory = result[1].rows;
      state.allError = result[1].error;
      state.allLoading = false;
      paint();
    });
  }

  function loadAllCustomers() {
    return sb().from('customers')
      .select('id,code,name,mobile')
      .order('name', true)
      .then(function (res) {
        return (!res.error && res.data) ? res.data : [];
      });
  }

  function loadAllRows() {
    var size = 500;
    var from = 0;
    var rows = [];
    var seen = {};
    var pages = 0;

    function nextPage() {
      return sb().from('measurements')
        .select('*')
        .order('created_at', false)
        .range(from, from + size - 1)
        .then(function (res) {
          if (res.error) throw res.error;
          var page = res.data || [];
          var added = 0;
          page.forEach(function (r) {
            if (r && r.id && !seen[r.id]) {
              seen[r.id] = true;
              rows.push(r);
              added++;
            }
          });

          // A short page is the end. An empty repeat also ends a paged source
          // that keeps handing back the same rows, so it cannot loop forever.
          if (page.length < size || added === 0 || ++pages >= 100) {
            return { rows: rows, error: null };
          }
          from += size;
          return nextPage();
        });
    }

    return nextPage().catch(function (e) {
      return { rows: rows, error: (e && e.message) || 'The measurements could not be loaded.' };
    });
  }

  function searchCustomers(term) {
    var t = String(term || '').trim();
    if (t.length < 1) {
      state.customers = [];
      paint();
      return Promise.resolve();
    }

    // The term itself is the filter. It used to be gated on state.search, which
    // is the (unrelated, always empty) list filter, so typing never narrowed
    // anything and the first eight customers were always shown instead.
    var clean = '*' + t.replace(/[*%,()]/g, ' ') + '*';
    return sb().from('customers')
      .select('id,code,name,mobile')
      .or('name.ilike.' + clean + ',mobile.ilike.' + clean + ',code.ilike.' + clean)
      .order('name', true)
      .limit(8)
      .then(function (res) {
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
    host.innerHTML = pageHead() + picker() + (state.customer ? detail() : allCard());
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

  /* Default view: every saved measurement, with the customer named on each
   * block. Searching above still narrows the page to one customer's detail. */
  function allCard() {
    if (state.allError) return errorCard(state.allError);

    var rows = state.allHistory;

    if (state.allLoading && !rows.length) {
      return '<div class="ui-card"><div class="empty"><div class="empty-title">Loading measurements...</div></div></div>';
    }

    if (!rows.length) {
      return '<div class="ui-card"><div class="empty">' +
        '<div class="empty-title">No measurements yet</div>' +
        '<p class="empty-text">Search above to choose a customer, then record their first measurement.</p>' +
      '</div></div>';
    }

    return '<div class="ui-card">' +
      '<h2 class="ui-card-title">All measurements</h2>' +
      '<p class="ui-card-sub">' + rows.length + (rows.length === 1 ? ' record' : ' records') +
        ', newest first across every customer. Search above to open one customer’s history.</p>' +
      rows.map(function (m) { return historyBlock(m, true); }).join('') +
    '</div>';
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
      '<button class="btn btn-secondary" id="msrChange">All measurements</button>' +
    '</div>' +
    (state.error ? errorCard() : '') +
    (state.form ? formHtml() : newButton()) +
    historyCard();
  }

  function errorCard(message) {
    return '<div class="ui-card"><div class="empty">' +
      '<div class="empty-title">Could not load measurements</div>' +
      '<p class="empty-text">' + esc(message || state.error) + '</p>' +
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

  function historyBlock(m, global) {
    var values = m.values || {};
    var keys = Object.keys(values);
    var filled = keys.filter(function (k) {
      return String(values[k] == null ? '' : values[k]).trim() !== '';
    });
    var cust = global ? customerFor(m.customer_id) : null;
    var customerLine = '';

    if (global) {
      var meta = cust && (cust.code || cust.mobile)
        ? '<span class="msr-block-customer-meta">' + esc(cust.code || '') +
            (cust.code && cust.mobile ? ' · ' : '') + esc(cust.mobile || '') + '</span>'
        : '';
      customerLine = '<div class="msr-block-customer">' +
        esc((cust && cust.name) || 'Customer') + meta + '</div>';
    }

    return '<div class="msr-block">' +
      '<div class="msr-block-head">' +
        '<div>' +
          customerLine +
          '<span class="msr-block-dress">' + esc(m.dress_type) + '</span>' +
          '<span class="msr-block-code">' + esc(m.code) + '</span>' +
        '</div>' +
        '<div class="msr-block-actions">' +
          '<span class="msr-block-date">' + esc(dateLabel(m.created_at)) + '</span>' +
          (global && cust && cust.id
            ? '<button class="btn btn-sm btn-quiet" data-msr-open-cust="' + esc(cust.id) + '">Open customer</button>'
            : '') +
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

  function customerFor(id) {
    if (!id) return null;
    if (state.customer && state.customer.id === id) return state.customer;
    return state.allCustomers.filter(function (c) { return c.id === id; })[0] || null;
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
          // inputmode="numeric" puts a digits-only keypad on a phone, and
          // wire() keeps the stored value numeric. One decimal point is
          // allowed because a tailor does record 40.5.
          '<input class="ui-input" id="' + esc(fid) + '" data-msr-field="' + esc(f) + '" ' +
            'type="text" inputmode="numeric" ' +
            'value="' + esc(v === undefined || v === null ? '' : v) + '" autocomplete="off">' +
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
    var found = state.history.concat(state.allHistory).filter(function (r) { return r.id === id; })[0];
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

      // When this form was opened from an order, put the new measurement back
      // on the row the tailor came from instead of dropping them here.
      if (returnToOrder) {
        returnToOrder = false;
        var row = (res.data && (res.data.id ? res.data : res.data[0])) || {};
        if (window.ANT.orders && typeof window.ANT.orders.resumeFromMeasurement === 'function') {
          return window.ANT.orders.resumeFromMeasurement(row.id || null);
        }
      }

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

  // Codes read AN-MEA-<YY>-<NNNN>: brand, type, two-digit year, running serial.
  // The serial is drawn from the database counter (next_code), which never
  // hands the same number out twice and resets each year.
  var TYPE = 'MEA';

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

  function highestSerial() {
    return sb().from('measurements')
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

  function insertMeasurement(payload, attempt, serial) {
    attempt = attempt || 0;
    return nextCode(serial).then(function (code) {
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
          // The measurements_read policy hides archived rows from staff, so the
          // highest readable code may already be taken. Step to the next number
          // rather than fail on a key the user cannot act on.
          if (isDuplicateCode(res) && attempt < 50) {
            var s = serialFromCode(code);
            if (s != null) return insertMeasurement(payload, attempt + 1, s + 1);
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

  // A 409 from PostgREST is a unique violation (Postgres 23505). The message is
  // checked as well so the retry keeps working if the status is ever dropped.
  function isDuplicateCode(res) {
    if (!res || !res.error) return false;
    if (res.error.status === 409) return true;
    var m = String(res.error.message || '').toLowerCase();
    return m.indexOf('duplicate') > -1 || m.indexOf('unique') > -1;
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

  // Digits and at most one decimal point, nothing else. A second dot truncates
  // the rest of the box rather than being joined up, because joining "12.3.4"
  // into "12.34" would quietly change the number the tailor typed. A lone "."
  // is discarded because it is not a measurement.
  function cleanNumber(str) {
    var s = String(str || '').replace(/[^0-9.]/g, '');
    var firstDot = s.indexOf('.');
    if (firstDot !== -1) {
      s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\..*$/, '');
    }
    if (s === '.') s = '';
    return s;
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
        state.dressType = '';
        state.customerQuery = '';
        state.customers = [];
        returnToOrder = false;
        loadAll();
      });
    }

    // A block in the global list can open the customer it belongs to, so the
    // tailor does not have to retype a name to see that person's full history.
    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-open-cust]'), function (btn) {
      btn.addEventListener('click', function () {
        var c = customerFor(btn.getAttribute('data-msr-open-cust'));
        if (!c) return toast('That customer is not available to open.', 'error');
        state.customer = c;
        state.customerQuery = c.name || '';
        state.customers = [];
        state.form = null;
        state.dressType = '';
        paint();
        loadHistory();
      });
    });

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

    // Measurement boxes accept digits and at most one decimal point. Enforcing
    // it here rather than with an inline oninput attribute keeps the rule in
    // one place and does not depend on script load order.
    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-field]'), function (input) {
      input.addEventListener('input', function () {
        var cleaned = cleanNumber(input.value);
        if (cleaned === input.value) return;
        var atEnd = input.selectionStart === input.value.length;
        input.value = cleaned;
        if (atEnd) {
          try { input.setSelectionRange(cleaned.length, cleaned.length); } catch (err) {}
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-msr-copy]'), function (btn) {
      btn.addEventListener('click', function () {
        var row = findRow(btn.getAttribute('data-msr-copy'));
        if (!row) return;

        // "Copy to new" needs a customer to save against. In the all-records
        // view, take it from the row being copied instead of asking for a search.
        if (!state.customer && row.customer_id) {
          var c = customerFor(row.customer_id);
          state.customer = c || { id: row.customer_id, code: '', name: 'Customer', mobile: '' };
          state.customerQuery = c ? (c.name || '') : '';
        }
        if (!state.customer) {
          return toast('Choose a customer first.', 'error');
        }

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

  // Select the customer and put the new-measurement form straight on screen.
  function applyCustomer(c, opts) {
    if (!c) return;
    state.customer = c;
    state.customerQuery = c.name || '';
    state.customers = [];
    state.form = 'new';
    // An order knows the garment already, so start on that dress type.
    state.dressType = (opts && opts.dressType) || '';
    paint();
    loadHistory();
  }

  /* A Customers row action sends the person here. The customer is remembered
   * and the normal route change renders the page, so the tailor lands on the
   * form with them already chosen. An order can also ask for the saved row to
   * be put straight back on the item it came from. */
  function focusCustomer(c, opts) {
    if (!c) return Promise.resolve();
    pendingCustomer = c;
    pendingOptions = opts || null;
    returnToOrder = !!(opts && opts.returnToOrder);
    var here = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (here === 'measurements') return Promise.resolve(render());
    location.hash = '#/measurements';
    return Promise.resolve();
  }

  var api = {
    mount: function () {
      return '<div id="measurementsView"></div>';
    },

    cleanNumber: cleanNumber,

    focusCustomer: focusCustomer,

    render: function () {
      var pending = pendingCustomer;
      var opts = pendingOptions;
      pendingCustomer = null;
      pendingOptions = null;
      if (!pending) returnToOrder = false;

      state.search = '';
      state.customerQuery = '';
      state.customers = [];
      state.customer = null;
      state.history = [];
      state.allHistory = [];
      state.allCustomers = [];
      state.allLoading = false;
      state.allError = null;
      state.form = null;
      state.dressType = '';
      paint();

      // No hand-off means the tailor simply opened the page: show everything.
      if (!pending) return loadAll();
      if (typeof pending !== 'string') return applyCustomer(pending, opts);
      return sb().from('customers')
        .select('id,code,name,mobile')
        .eq('id', pending)
        .limit(1)
        .then(function (res) {
          if (res.error || !res.data || !res.data.length) return loadAll();
          applyCustomer(res.data[0], opts);
        });
    }
  };

  // focusCustomer calls this directly when the browser is already here.
  function render() {
    return api.render();
  }

  return api;
})();

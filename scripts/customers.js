/* AN TAILOR - Customers.
 *
 * Reads and writes the `customers` table through PostgREST. Every query is
 * subject to the database's Row Level Security, so this module does not decide
 * what a role may see. It hides what the role cannot use, and the database
 * refuses anything that slips through.
 *
 * Deleting is deliberately not the normal path. orders.customer_id is ON DELETE
 * RESTRICT, so a customer who has ever placed an order can never be removed by
 * anyone. Archiving is the everyday action; deleting only helps for a customer
 * created by mistake who never had an order.
 */

window.ANT = window.ANT || {};

window.ANT.customers = (function () {
  var sb = function () { return window.ANT.sb; };
  var esc = function (v) { return window.ANT.escapeHtml(v); };
  var toast = function (m, k) { return window.ANT.toast(m, k); };

  var PAGE_SIZE = 25;

  var state = {
    search: '',
    showArchived: false,
    page: 0,
    total: 0,
    rows: [],
    loading: false,
    form: null,   // null = closed, 'new', or a customer row being edited
    error: null
  };

  function me() {
    return window.ANT.auth.current() || {};
  }

  function isOwner() {
    return me().role === 'owner';
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /* Customer code ----------------------------------------------------- */

  // Codes are C0001 upward, zero padded so a lexicographic sort matches the
  // numeric order. A unique-violation retry covers the case where two people
  // add a customer at the same moment.
  function nextCode(attempt) {
    return sb().from('customers')
      .select('code')
      .order('code', false)
      .limit(1)
      .then(function (res) {
        var n = 1;
        if (!res.error && res.data && res.data.length) {
          var m = /(\d+)\s*$/.exec(res.data[0].code || '');
          if (m) n = parseInt(m[1], 10) + 1;
        }
        return 'C' + String(n).padStart(4, '0');
      });
  }

  function insertCustomer(values, attempt) {
    attempt = attempt || 0;
    return nextCode().then(function (code) {
      var payload = {
        code: code,
        name: values.name,
        mobile: values.mobile || '',
        address: values.address || '',
        notes: values.notes || '',
        status: 'ACTIVE'
      };
      return sb().from('customers').insert(payload).single().then(function (res) {
        // 23505 is unique_violation, which means we raced another insert.
        if (res.error && res.error.status === 409 && attempt < 3) {
          return insertCustomer(values, attempt + 1);
        }
        return res;
      });
    });
  }

  /* Loading ------------------------------------------------------------ */

  function buildQuery() {
    var q = sb().from('customers').select('*', { count: true });

    if (state.search) {
      var term = '*' + state.search.replace(/[*%,()]/g, ' ') + '*';
      q = q.or('name.ilike.' + term + ',mobile.ilike.' + term + ',code.ilike.' + term);
    }

    // Staff are already restricted to live rows by RLS. The owner sees
    // everything, so the toggle is only offered to them.
    if (state.showArchived) {
      q = q.not('archived_at', 'is', null);
    }

    q = q.order('name', true).order('created_at', false);
    return q.range(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE - 1);
  }

  function load() {
    state.loading = true;
    paint();

    return buildQuery().then(function (res) {
      state.loading = false;

      if (res.error) {
        state.error = res.error.message;
        state.rows = [];
      } else {
        state.error = null;
        state.rows = res.data || [];
        if (res.count !== null && res.count !== undefined) state.total = res.count;
        else state.total = state.rows.length;
      }
      paint();
    });
  }

  function pageHead() {
    return '<div class="page-head">' +
      '<div>' +
        '<h1 class="page-head-title">Customers</h1>' +
        '<p class="page-head-sub">Everyone who has walked into the shop. Archived customers are kept, never thrown away.</p>' +
      '</div>' +
      '<div class="page-head-actions">' +
        '<button class="btn btn-primary" id="custNew">+ New customer</button>' +
      '</div>' +
    '</div>';
  }

  function toolbar() {
    var showing = state.rows.length;
    var total = state.total;
    var from = state.page * PAGE_SIZE + 1;
    var to = state.page * PAGE_SIZE + state.rows.length;

    return '<div class="cust-toolbar">' +
      '<input class="ui-input cust-search" id="custSearch" type="search" ' +
        'placeholder="Search name, mobile or code" value="' + esc(state.search) + '" ' +
        'autocomplete="off" spellcheck="false">' +
      (isOwner()
        ? '<label class="cust-toggle"><input type="checkbox" id="custArchived"' +
            (state.showArchived ? ' checked' : '') + '> Show archived only</label>'
        : '') +
      '<span class="cust-count">' +
        (state.loading
          ? 'Loading...'
          : (total === 0
              ? 'No customers yet'
              : 'Showing ' + from + '-' + to + ' of ' + total)) +
      '</span>' +
    '</div>';
  }

  function rowHtml(c) {
    var archived = !!c.archived_at;
    var canEdit = true;

    return '<tr' + (archived ? ' class="cust-archived"' : '') + '>' +
      '<td class="cust-code">' + esc(c.code) + '</td>' +
      '<td class="cust-name">' + esc(c.name) + '</td>' +
      '<td class="num">' + esc(c.mobile || '—') + '</td>' +
      '<td>' + (archived ? '<span class="chip chip-muted">Archived</span>' : '<span class="chip chip-success">Active</span>') + '</td>' +
      '<td class="cust-actions">' +
        (canEdit ? '<button class="btn btn-sm btn-secondary" data-cust-edit="' + esc(c.id) + '">Edit</button>' : '') +
        (archived
          ? '<button class="btn btn-sm btn-quiet" data-cust-restore="' + esc(c.id) + '">Restore</button>'
          : '<button class="btn btn-sm btn-quiet" data-cust-archive="' + esc(c.id) + '">Archive</button>') +
        (isOwner() && !archived
          ? '<button class="btn btn-sm btn-danger" data-cust-delete="' + esc(c.id) + '">Delete</button>'
          : '') +
      '</td>' +
    '</tr>';
  }

  function table() {
    if (state.error) {
      return '<div class="empty">' +
        '<div class="empty-title">Could not load customers</div>' +
        '<p class="empty-text">' + esc(state.error) + '</p>' +
      '</div>';
    }

    if (!state.loading && state.rows.length === 0) {
      return '<div class="empty">' +
        '<div class="empty-title">' +
          (state.search ? 'No customer matches that search' : 'No customers yet') +
        '</div>' +
        '<p class="empty-text">' +
          (state.search
            ? 'Try part of a name or a mobile number.'
            : 'Add the first customer with the button above.') +
        '</p>' +
      '</div>';
    }

    return '<div class="table-wrap"><table class="ui-table">' +
      '<thead><tr>' +
        '<th>Code</th><th>Name</th><th>Mobile</th><th>Status</th><th></th>' +
      '</tr></thead>' +
      '<tbody>' + state.rows.map(rowHtml).join('') + '</tbody>' +
    '</table></div>' +
    (state.total > PAGE_SIZE ? pager() : '');
  }

  function pager() {
    var pages = Math.ceil(state.total / PAGE_SIZE);
    var atStart = state.page === 0;
    var atEnd = state.page >= pages - 1;
    return '<div class="cust-pager">' +
      '<button class="btn btn-sm btn-secondary" id="custPrev"' + (atStart ? ' disabled' : '') + '>Previous</button>' +
      '<span>Page ' + (state.page + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="custNext"' + (atEnd ? ' disabled' : '') + '>Next</button>' +
    '</div>';
  }

  function formHtml() {
    if (!state.form) return '';
    var editing = state.form !== 'new';
    var c = editing ? state.form : {};

    return '<div class="ui-card cust-form" id="custFormCard">' +
      '<h2 class="ui-card-title">' + (editing ? 'Edit customer' : 'New customer') + '</h2>' +
      '<p class="ui-card-sub">' +
        (editing
          ? 'Code ' + esc(c.code) + ' cannot be changed.'
          : 'The code is generated automatically. Mobile is stored as text so leading zeros survive.') +
      '</p>' +
      '<form id="custForm" novalidate>' +
        '<div class="form-grid">' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="custName">Name</label>' +
            '<input class="ui-input" id="custName" value="' + esc(editing ? c.name : '') + '" required maxlength="120" autocomplete="off">' +
          '</div>' +
          '<div class="ui-field">' +
            '<label class="ui-label" for="custMobile">Mobile</label>' +
            '<input class="ui-input" id="custMobile" value="' + esc(editing ? (c.mobile || '') : '') + '" inputmode="tel" maxlength="25" autocomplete="off">' +
            '<p class="ui-hint">Digits only. Stored as text.</p>' +
          '</div>' +
        '</div>' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="custAddress">Address</label>' +
          '<textarea class="ui-textarea" id="custAddress" rows="2" maxlength="400">' + esc(editing ? (c.address || '') : '') + '</textarea>' +
        '</div>' +
        '<div class="ui-field">' +
          '<label class="ui-label" for="custNotes">Notes</label>' +
          '<textarea class="ui-textarea" id="custNotes" rows="2" maxlength="1000">' + esc(editing ? (c.notes || '') : '') + '</textarea>' +
        '</div>' +
        '<div class="cust-form-actions">' +
          '<button class="btn btn-primary" type="submit">' + (editing ? 'Save changes' : 'Add customer') + '</button>' +
          '<button class="btn btn-quiet" type="button" id="custCancel">Cancel</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function paint() {
    var host = byId('customersView');
    if (!host) return;
    host.innerHTML = pageHead() + formHtml() +
      '<div class="ui-card">' + toolbar() + table() + '</div>';
    wire();
    focusSearchEnd();
  }

  var searchTimer = null;

  function focusSearchEnd() {
    var input = byId('custSearch');
    if (!input || document.activeElement === input) return;
    if (input.value) {
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }
  }

  /* Actions ------------------------------------------------------------ */

  function save(event) {
    event.preventDefault();

    var name = byId('custName').value.trim();
    var mobile = byId('custMobile').value.trim();
    var address = byId('custAddress').value.trim();
    var notes = byId('custNotes').value.trim();

    if (!name) {
      toast('Enter a name', 'error');
      byId('custName').focus();
      return;
    }

    var values = { name: name, mobile: mobile, address: address, notes: notes };
    var editing = state.form !== 'new';

    var work = editing
      ? sb().from('customers')
          .update(values)
          .eq('id', state.form.id)
          .select('id')
          .then(function (res) {
            // An empty result means RLS filtered the row out, not a crash.
            if (res.error) return res;
            if (!res.data || res.data.length === 0) {
              return { error: { message: 'You do not have permission to edit this customer.' } };
            }
            return res;
          })
      : insertCustomer(values);

    work.then(function (res) {
      if (res.error) {
        toast(res.error.message, 'error');
        return;
      }
      state.form = null;
      toast(editing ? 'Customer updated' : 'Customer added', 'success');
      load();
    });
  }

  function archive(id) {
    sb().from('customers')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        if (!res.data || res.data.length === 0) {
          return toast('You do not have permission to archive this customer.', 'error');
        }
        toast('Customer archived', 'success');
        load();
      });
  }

  function restore(id) {
    sb().from('customers')
      .update({ archived_at: null })
      .eq('id', id)
      .select('id')
      .then(function (res) {
        if (res.error) return toast(res.error.message, 'error');
        if (!res.data || res.data.length === 0) {
          return toast('You do not have permission to restore this customer.', 'error');
        }
        toast('Customer restored', 'success');
        load();
      });
  }

  function remove(id) {
    if (!window.confirm('Delete this customer permanently?\n\nThis only works if they have never had an order. If they have, archive them instead so the order history survives.')) {
      return;
    }
    sb().from('customers').delete().eq('id', id).select('id').then(function (res) {
      if (res.error) {
        // 23503 is the foreign key: they have orders, so archiving is the route.
        if (res.error.status === 409 || /foreign key/i.test(res.error.message)) {
          return toast('This customer has orders and cannot be deleted. Archive them instead.', 'error');
        }
        return toast(res.error.message, 'error');
      }
      if (!res.data || res.data.length === 0) {
        return toast('You do not have permission to delete this customer.', 'error');
      }
      toast('Customer deleted', 'success');
      load();
    });
  }

  /* Wiring ------------------------------------------------------------- */

  function wire() {
    var newBtn = byId('custNew');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        state.form = 'new';
        paint();
        var field = byId('custName');
        if (field) field.focus();
      });
    }

    var cancel = byId('custCancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        state.form = null;
        paint();
      });
    }

    var form = byId('custForm');
    if (form) form.addEventListener('submit', save);

    var search = byId('custSearch');
    if (search) {
      search.addEventListener('input', function (e) {
        state.search = e.target.value;
        state.page = 0;
        if (searchTimer) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
          // Repaint would steal the caret, so only the table is redrawn.
          var value = e.target.value;
          load().then(function () {
            var again = byId('custSearch');
            if (again) {
              again.value = value;
              again.focus();
              try { again.setSelectionRange(value.length, value.length); } catch (err) {}
            }
          });
        }, 260);
      });
    }

    var archivedBox = byId('custArchived');
    if (archivedBox) {
      archivedBox.addEventListener('change', function (e) {
        state.showArchived = e.target.checked;
        state.page = 0;
        load();
      });
    }

    var prev = byId('custPrev');
    if (prev) {
      prev.addEventListener('click', function () {
        if (state.page === 0) return;
        state.page -= 1;
        load();
      });
    }

    var next = byId('custNext');
    if (next) {
      next.addEventListener('click', function () {
        state.page += 1;
        load();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-cust-edit]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-cust-edit');
        var found = state.rows.filter(function (r) { return r.id === id; })[0];
        if (found) {
          state.form = found;
          paint();
          var field = byId('custName');
          if (field) field.focus();
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cust-archive]'), function (btn) {
      btn.addEventListener('click', function () {
        archive(btn.getAttribute('data-cust-archive'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cust-restore]'), function (btn) {
      btn.addEventListener('click', function () {
        restore(btn.getAttribute('data-cust-restore'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cust-delete]'), function (btn) {
      btn.addEventListener('click', function () {
        remove(btn.getAttribute('data-cust-delete'));
      });
    });
  }

  return {
    mount: function () {
      return '<div id="customersView"></div>';
    },

    render: function () {
      state.search = '';
      state.page = 0;
      state.form = null;
      state.showArchived = false;
      paint();
      load();
    }
  };
})();

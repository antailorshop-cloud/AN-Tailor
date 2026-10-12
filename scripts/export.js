/* The Backup tab's reading half: every table the shop owns, turned into one CSV
 * per table and zipped. Kept away from settings.js because it is mostly a
 * description of the schema and the reading of it, and because a page of table
 * definitions would bury the small bit of UI that calls it.
 *
 * The read is the same one the app makes all day, so RLS decides what is in the
 * file: a signed-in member sees what their sign-in already sees. The tables are
 * read a page at a time, because PostgREST caps how many rows one request may
 * return and a shop that has run for years will have more orders than that.
 */
(function () {
  var PAGE = 1000;

  // Business records first, then the setup that gives them meaning. `cols` is
  // the header of each file and the order of the cells: it is written out rather
  // than taken from the first row so an empty table still has a header, and so
  // a column added later does not silently reorder an old backup.
  var TABLES = [
    { file: 'customers', table: 'customers', order: ['code'],
      cols: ['code', 'name', 'mobile', 'address', 'notes', 'status',
        'created_at', 'updated_at', 'archived_at'] },

    { file: 'measurements', table: 'measurements', order: ['code'],
      cols: ['code', 'customer_id', 'category', 'dress_type', 'values', 'notes',
        'created_at', 'updated_at', 'archived_at'] },

    { file: 'orders', table: 'orders', order: ['code'],
      cols: ['code', 'customer_id', 'measurement_id', 'order_date', 'delivery_date',
        'status', 'priority', 'total', 'discount', 'advance', 'balance', 'notes',
        'line_model', 'item_count', 'created_at', 'updated_at', 'archived_at'] },

    { file: 'order_items', table: 'order_items', order: ['order_id', 'line_no'],
      cols: ['order_id', 'line_no', 'measurement_id', 'category', 'dress_type',
        'service', 'variant', 'lining', 'resale_item_id', 'quantity', 'rate',
        'discount', 'extra_charge', 'line_total', 'delivery_date', 'archived_at'] },

    { file: 'bills', table: 'bills', order: ['code'],
      cols: ['code', 'customer_id', 'total', 'discount', 'advance', 'bill_amount',
        'balance', 'bill_date', 'notes', 'method', 'paid_on', 'print_size',
        'created_at', 'updated_at', 'archived_at'] },

    { file: 'bill_orders', table: 'bill_orders', order: ['bill_id'],
      cols: ['bill_id', 'order_id'] },

    { file: 'payments', table: 'payments', order: ['code'],
      cols: ['code', 'order_id', 'customer_id', 'amount', 'method', 'reference',
        'previous_balance', 'new_balance', 'notes', 'paid_on', 'created_at',
        'updated_at'] },

    { file: 'resale_stock', table: 'resale_stock', order: ['code'],
      cols: ['code', 'item', 'quantity', 'buy_price', 'sell_price', 'total_cost',
        'buy_date', 'notes', 'created_at', 'updated_at'] },

    { file: 'prices', table: 'prices', order: ['code'],
      cols: ['code', 'group_name', 'item', 'option', 'price', 'extra_charge',
        'status', 'created_at', 'updated_at'] },

    { file: 'dress_types', table: 'dress_types', order: ['category', 'dress_type'],
      cols: ['category', 'dress_type', 'is_default', 'created_at'] },

    { file: 'shop_settings', table: 'shop_settings', order: ['key'],
      cols: ['key', 'value', 'updated_at'] },

    { file: 'staff', table: 'profiles', order: ['display_name'],
      cols: ['email', 'display_name', 'role', 'phone', 'address', 'active',
        'created_at', 'updated_at'] },

    { file: 'staff_access', table: 'staff_access', order: ['user_id', 'area'],
      cols: ['user_id', 'area', 'level'] }
  ];

  // Every row, a page at a time. A page shorter than the last request is the end
  // only if the server returned what was asked for; instead the loop keeps going
  // until a page comes back empty, which is correct whatever max-rows is set to.
  function fetchAll(def) {
    var out = [];

    function step(from) {
      var q = window.ANT.sb.from(def.table).select('*');
      (def.order || []).forEach(function (c) { q = q.order(c, true); });
      return q.range(from, from + PAGE - 1).then(function (res) {
        if (res.error) {
          throw new Error(def.table + ': ' + (res.error.message || res.error));
        }
        var rows = res.data || [];
        out = out.concat(rows);
        if (!rows.length) return out;
        return step(from + rows.length);
      });
    }

    return step(0);
  }

  // A cell as CSV wants it: nulls and blanks are empty, anything with a comma, a
  // quote or a line break is wrapped and its quotes doubled. A jsonb value (a
  // measurement's `values`) is written as its JSON text so nothing is lost.
  function cell(v) {
    if (v === null || v === undefined) return '';
    var s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(def, rows) {
    var lines = [def.cols.join(',')];
    rows.forEach(function (r) {
      lines.push(def.cols.map(function (c) { return cell(r[c]); }).join(','));
    });
    // Excel needs the BOM to read ₹ and non-English names as UTF-8 rather than
    // as the local code page, which turns them into mojibake.
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function stamp(d) {
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  // Saves without navigating the app away, the same way the WhatsApp and UPI
  // links are made: a real anchor, clicked, then taken back off the page.
  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Reads every table in turn, then zips the CSVs. Resolves with the row count
  // per table so the caller can say how much was written.
  function gather() {
    var files = [];
    var counts = [];

    return TABLES.reduce(function (chain, def) {
      return chain.then(function () {
        return fetchAll(def).then(function (rows) {
          files.push({ name: def.file + '.csv', data: toCsv(def, rows) });
          counts.push(rows.length);
        });
      });
    }, Promise.resolve()).then(function () {
      return { files: files, counts: counts };
    });
  }

  function run() {
    return gather().then(function (res) {
      var blob = window.ANT.zip.build(res.files);
      save(blob, 'AN-Tailor-backup-' + stamp(new Date()) + '.zip');
      return res;
    });
  }

  window.ANT = window.ANT || {};
  window.ANT.export = {
    run: run,
    gather: gather,
    toCsv: toCsv,
    tables: TABLES
  };
})();

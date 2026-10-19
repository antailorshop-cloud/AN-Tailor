/* Bringing the shop's old records in from a filled-in Excel workbook.
 *
 * The Backup/Import tab speaks the app's own language: one CSV per table, every
 * row carrying the uuid id it points at. That is fine for a machine but useless
 * to a tailor who has their old records in a spreadsheet. This module sits in
 * front of it: it reads the .xlsx the shop fills in, maps the friendly column
 * names a person typed onto the real columns, and - the part a spreadsheet
 * cannot do on its own - invents the uuids and links the rows up by the codes
 * the shop wrote. The result is handed to restore.js, which does the actual
 * matching and inserting, so both entry points share one set of rules.
 *
 * Only three sheets are understood, the three every shop has: Customers,
 * Orders (with one or more item lines each) and Payments. A row is linked to
 * the row it belongs to by the code written in the Customers sheet, exactly as
 * a person would cross-reference their own paperwork.
 */
(function () {
  /* Columns ------------------------------------------------------------- */

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  var CUSTOMER_COLS = [
    { key: 'code', label: 'Customer Code', sample: 'C001',
      aliases: ['customercode', 'custcode', 'customerno', 'custno', 'code'] },
    { key: 'name', label: 'Name', sample: 'Asha',
      aliases: ['name', 'customername', 'customer'] },
    { key: 'mobile', label: 'Mobile', sample: '9800000000',
      aliases: ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'contact', 'contactno'] },
    { key: 'address', label: 'Address', sample: '12, Main Road',
      aliases: ['address', 'place'] },
    { key: 'notes', label: 'Notes', sample: '',
      aliases: ['notes', 'note', 'remarks'] },
    { key: 'status', label: 'Status', sample: 'ACTIVE',
      aliases: ['status'] }
  ];

  var ORDER_COLS = [
    { key: 'order_code', label: 'Order Code', sample: 'O001',
      aliases: ['ordercode', 'orderno', 'orderid', 'billno', 'billnumber'] },
    { key: 'customer_code', label: 'Customer Code', sample: 'C001',
      aliases: ['customercode', 'custcode', 'customerno', 'custno'] },
    { key: 'order_date', label: 'Order Date', sample: '2026-01-05',
      aliases: ['orderdate', 'date', 'billdate'] },
    { key: 'delivery_date', label: 'Delivery Date', sample: '2026-01-20',
      aliases: ['deliverydate', 'delivery', 'duedate'] },
    { key: 'status', label: 'Status', sample: 'Pending',
      aliases: ['status'] },
    { key: 'priority', label: 'Priority', sample: 'Normal',
      aliases: ['priority'] },
    { key: 'item', label: 'Item / Dress', sample: 'Shirt - White',
      aliases: ['item', 'items', 'dress', 'dresses', 'dressdescription', 'description',
        'garment', 'particulars', 'product'] },
    { key: 'quantity', label: 'Quantity', sample: '1',
      aliases: ['quantity', 'qty', 'nos'] },
    { key: 'rate', label: 'Rate', sample: '700',
      aliases: ['rate', 'price', 'unitprice'] },
    { key: 'amount', label: 'Amount', sample: '700',
      aliases: ['amount', 'total', 'lineamount', 'value'] },
    { key: 'discount', label: 'Discount', sample: '0',
      aliases: ['discount'] },
    { key: 'advance', label: 'Advance', sample: '200',
      aliases: ['advance', 'paid', 'advancepaid'] },
    { key: 'notes', label: 'Notes', sample: '',
      aliases: ['notes', 'note', 'remarks'] }
  ];

  var PAYMENT_COLS = [
    { key: 'payment_code', label: 'Payment Code', sample: 'P001',
      aliases: ['paymentcode', 'paymentno', 'receiptno'] },
    { key: 'customer_code', label: 'Customer Code', sample: 'C001',
      aliases: ['customercode', 'custcode', 'customerno', 'custno'] },
    { key: 'order_code', label: 'Order Code', sample: 'O001',
      aliases: ['ordercode', 'orderno'] },
    { key: 'amount', label: 'Amount', sample: '200',
      aliases: ['amount', 'paid', 'payment', 'value'] },
    { key: 'method', label: 'Method', sample: 'CASH',
      aliases: ['method', 'mode', 'paymentmode', 'type'] },
    { key: 'paid_on', label: 'Paid On', sample: '2026-01-06',
      aliases: ['paidon', 'date', 'paymentdate'] },
    { key: 'notes', label: 'Notes', sample: '',
      aliases: ['notes', 'note', 'remarks'] }
  ];

  // Measurements are stored as one row per customer and dress type, with the
  // field names and numbers in a json object. A spreadsheet is flatter than
  // that, so this sheet is written one line per field - "Chest, 40" - and the
  // rows sharing a Customer Code and Dress Type are folded into a single
  // measurement, exactly as order lines sharing an Order Code fold into one
  // order.
  var MEASUREMENT_COLS = [
    { key: 'customer_code', label: 'Customer Code', sample: 'C001',
      aliases: ['customercode', 'custcode', 'customerno', 'custno'] },
    { key: 'category', label: 'Category', sample: 'Gents',
      aliases: ['category', 'gender', 'for', 'type'] },
    { key: 'dress_type', label: 'Dress Type', sample: 'Shirt',
      aliases: ['dresstype', 'dress', 'garment', 'item', 'clothing'] },
    { key: 'measure', label: 'Measure', sample: 'Chest',
      aliases: ['measure', 'measurement', 'field', 'parameter', 'part', 'particulars', 'name'] },
    { key: 'value', label: 'Value', sample: '40',
      aliases: ['value', 'size', 'inch', 'inches', 'measurementvalue', 'result', 'reading'] },
    { key: 'notes', label: 'Notes', sample: '',
      aliases: ['notes', 'note', 'remarks'] }
  ];

  // Which dress types a tailor cuts for whom, matching dress_types.category.
  var GENTS = ['Shirt', 'T-Shirt', 'Kurta', 'Pant / Trouser', 'Dhoti', 'Waistcoat',
    'Sherwani', 'Safari Suit', 'Suit / Blazer'];
  var LADIES = ['Blouse', 'Churidar / Salwar', 'Kurti', 'Salwar Kameez', 'Anarkali',
    'Lehenga Blouse', 'Pant', 'Palazzo', 'Maxi', 'Nighty'];

  function categoryFor(dress) {
    if (GENTS.indexOf(dress) !== -1) return 'Gents';
    if (LADIES.indexOf(dress) !== -1) return 'Ladies';
    return '';
  }

  var SHEETS = [
    { table: 'customers', title: 'Customers', names: ['customers', 'customer'],
      cols: CUSTOMER_COLS },
    { table: 'measurements', title: 'Measurements', names: ['measurements', 'measurement'],
      cols: MEASUREMENT_COLS,
      sampleRows: [
        ['C001', 'Gents', 'Shirt', 'Chest', '40', ''],
        ['C001', 'Gents', 'Shirt', 'Waist', '34', ''],
        ['C001', 'Gents', 'Shirt', 'Sleeve Length', '24', '']
      ] },
    { table: 'orders', title: 'Orders', names: ['orders', 'order'], cols: ORDER_COLS },
    { table: 'payments', title: 'Payments', names: ['payments', 'payment'], cols: PAYMENT_COLS }
  ];

  // A lookup from every accepted spelling to the column it means, built once per
  // sheet so a header can be matched whatever the tailor happened to type.
  function lookupFor(cols) {
    var map = {};
    cols.forEach(function (c) {
      map[norm(c.label)] = c.key;
      map[norm(c.key)] = c.key;
      (c.aliases || []).forEach(function (a) { map[norm(a)] = c.key; });
    });
    return map;
  }

  function headerMap(header, cols) {
    var lookup = lookupFor(cols);
    var map = {};
    (header || []).forEach(function (cell, i) {
      var key = lookup[norm(cell)];
      if (key && !(key in map)) map[key] = i;
    });
    return map;
  }

  function pickRow(cells, map) {
    var out = {};
    Object.keys(map).forEach(function (key) {
      var v = cells[map[key]];
      out[key] = v == null ? '' : String(v).trim();
    });
    return out;
  }

  function anyValue(row) {
    return Object.keys(row).some(function (k) { return String(row[k] || '').trim() !== ''; });
  }

  /* Small helpers -------------------------------------------------------- */

  function uuid() {
    var c = window.crypto || {};
    if (c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
      h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function num(v) {
    var n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  function round(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  // A cell that is a date. Excel keeps dates as a count of days from 1899-12-30
  // unless the cell is text, so a bare number is read that way; anything else is
  // taken as written and only the date part is kept.
  function excelDate(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return '';
    if (/^\d+(\.\d+)?$/.test(s)) {
      var days = parseFloat(s);
      if (days > 59) days -= 1;              // Excel's 1900 leap-year bug
      var ms = Math.round((days - 25569) * 86400 * 1000);  // 25569 = 1970-01-01
      var d = new Date(ms);
      if (!isNaN(d.getTime())) {
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
      }
      return s;
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    var parts = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
    if (parts) {
      var dd = parts[1], mm = parts[2], yy = parts[3];
      if (yy.length === 2) yy = (Number(yy) > 70 ? '19' : '20') + yy;
      return yy + '-' + pad(mm, 2) + '-' + pad(dd, 2);
    }
    return s.slice(0, 10);
  }

  function status(v) {
    var s = String(v || '').trim().toLowerCase();
    if (s === 'process' || s === 'processing' || s === 'in progress' || s === 'working') return 'Process';
    if (s === 'finish' || s === 'finished' || s === 'ready' || s === 'completed') return 'Finish';
    if (s === 'delivery' || s === 'delivered') return 'Delivery';
    if (s === 'cancel' || s === 'cancelled' || s === 'canceled') return 'Cancelled';
    return 'Pending';
  }

  function priority(v) {
    var s = String(v || '').trim().toLowerCase();
    return (s === 'urgent' || s === 'high' || s === 'rush') ? 'Urgent' : 'Normal';
  }

  function method(v) {
    var s = String(v || '').trim().toUpperCase();
    return s || 'CASH';
  }

  /* Reading an .xlsx ----------------------------------------------------- */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('That Excel file could not be read.');
    }
    return doc;
  }

  function byLocal(node, name) {
    var all = node.getElementsByTagName('*');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].localName === name) out.push(all[i]);
    }
    return out;
  }

  function attr(node, local) {
    var a = node.attributes || [];
    for (var i = 0; i < a.length; i++) {
      if (a[i].localName === local || a[i].name === local) return a[i].value;
    }
    return null;
  }

  function textOf(node) {
    return node ? (node.textContent || '') : '';
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  function sharedStrings(zip) {
    var entry = zip['xl/sharedStrings.xml'];
    if (!entry) return [];
    var doc = parseXml(new TextDecoder('utf-8').decode(entry));
    return byLocal(doc, 'si').map(function (si) {
      return byLocal(si, 't').map(textOf).join('');
    });
  }

  function parseSheet(xml, shared) {
    var doc = parseXml(xml);
    var rows = byLocal(doc, 'row');
    return rows.map(function (row) {
      var cells = [];
      byLocal(row, 'c').forEach(function (c) {
        var idx = colIndex(attr(c, 'r'));
        var t = attr(c, 't');
        var val = '';
        if (t === 'inlineStr') {
          val = byLocal(c, 't').map(textOf).join('');
        } else if (t === 's') {
          var v = byLocal(c, 'v')[0];
          var n = v ? parseInt(textOf(v), 10) : -1;
          val = (n >= 0 && n < shared.length) ? shared[n] : '';
        } else {
          var vv = byLocal(c, 'v')[0];
          val = vv ? textOf(vv) : '';
        }
        cells[idx] = val;
      });
      var width = cells.length ? cells.length : 0;
      for (var i = 0; i < width; i++) if (cells[i] == null) cells[i] = '';
      return cells;
    });
  }

  // entries: [{ name, data:Uint8Array }] from the zip reader. Returns
  // [{ name, rows }] with the sheet's own name and its grid of strings.
  function workbookSheets(entries) {
    var zip = {};
    entries.forEach(function (e) { zip[e.name] = e.data; });
    var wbEntry = zip['xl/workbook.xml'];
    if (!wbEntry) throw new Error('That is not an Excel workbook.');
    var wb = parseXml(new TextDecoder('utf-8').decode(wbEntry));

    var rels = {};
    if (zip['xl/_rels/workbook.xml.rels']) {
      var rdoc = parseXml(new TextDecoder('utf-8').decode(zip['xl/_rels/workbook.xml.rels']));
      byLocal(rdoc, 'Relationship').forEach(function (r) {
        rels[attr(r, 'Id')] = attr(r, 'Target');
      });
    }

    var shared = sharedStrings(zip);
    var out = [];

    byLocal(wb, 'sheet').forEach(function (sh) {
      var name = attr(sh, 'name') || '';
      var rid = attr(sh, 'id');  // r:id has localName "id"
      var target = rels[rid] || '';
      if (/^\//.test(target)) target = target.slice(1);
      else if (target && target.indexOf('xl/') !== 0) target = 'xl/' + target;
      var data = zip[target];
      if (!data) return;
      out.push({ name: name, rows: parseSheet(new TextDecoder('utf-8').decode(data), shared) });
    });
    return out;
  }

  // A sheet named one of the accepted spellings, matched without case or spaces.
  function findSheet(sheets, names) {
    for (var i = 0; i < sheets.length; i++) {
      if (names.indexOf(norm(sheets[i].name)) !== -1) return sheets[i];
    }
    return null;
  }

  // The sheet for a named table, by its definition rather than its position.
  function findTable(sheets, table) {
    for (var i = 0; i < SHEETS.length; i++) {
      if (SHEETS[i].table === table) return findSheet(sheets, SHEETS[i].names);
    }
    return null;
  }

  /* Turning sheets into rows restore can use ----------------------------- */

  function splitHeader(sheet) {
    var rows = (sheet && sheet.rows) || [];
    var header = rows[0] || [];
    return { header: header, body: rows.slice(1) };
  }

  function buildTables(sheets, known) {
    var tables = {};
    var custByCode = {};
    var custCodeById = {};
    var orderByCode = {};
    var usedMeaCodes = {};
    var custSeq = 0, meaSeq = 0, ordSeq = 0, paySeq = 0;

    // Customers already in the shop, so a sheet that names one of them by
    // code still links up. Without this an order row that references an
    // existing customer by code produces a record with no customer_id, and
    // the insert is refused for want of a value that was there all along.
    var db = known || { byCode: {}, byMobile: {}, byName: {} };

    function resolveCustomer(custCode, row) {
      var code = String(custCode == null ? '' : custCode).trim();
      var lower = code.toLowerCase();
      if (lower && custByCode[lower]) {
        return { id: custByCode[lower], code: custCodeById[custByCode[lower]] || code };
      }
      if (lower && db.byCode[lower]) return db.byCode[lower];
      if (row) {
        var mobile = String(row.mobile == null ? '' : row.mobile).replace(/\D/g, '');
        if (mobile && db.byMobile[mobile]) return db.byMobile[mobile];
        var name = String(row.name == null ? '' : row.name).trim().toLowerCase();
        if (name && db.byName[name]) return db.byName[name];
      }
      return null;
    }

    var cs = findTable(sheets, 'customers');
    if (cs) {
      var ch = splitHeader(cs);
      var cmap = headerMap(ch.header, CUSTOMER_COLS);
      var customers = [];
      ch.body.forEach(function (cells) {
        var row = pickRow(cells, cmap);
        if (!anyValue(row)) return;
        var name = String(row.name || '').trim();
        // A record the shop cannot name is not a customer: the manual form
        // refuses one, so the importer must not invent one either. A name alone
        // is enough here, because a customer list often carries no phone column.
        if (!name) return;
        custSeq++;
        var code = String(row.code || '').trim() || ('IMP-CUS-' + pad(custSeq, 4));
        var rec = { id: uuid(), code: code, name: name };
        if (row.mobile) rec.mobile = String(row.mobile).trim();
        if (row.address) rec.address = String(row.address).trim();
        if (row.notes) rec.notes = String(row.notes).trim();
        if (row.status) rec.status = String(row.status).trim().toUpperCase();
        customers.push(rec);
        custByCode[code.toLowerCase()] = rec.id;
        custCodeById[rec.id] = code;
      });
      if (customers.length) tables.customers = customers;
    }

    var ms = findTable(sheets, 'measurements');
    if (ms) {
      var mh = splitHeader(ms);
      var mmap = headerMap(mh.header, MEASUREMENT_COLS);
      var measurements = [], meaByKey = {};
      mh.body.forEach(function (cells) {
        var row = pickRow(cells, mmap);
        if (!anyValue(row)) return;
        var dressType = String(row.dress_type || '').trim();
        var measure = String(row.measure || '').trim();
        var custCode = String(row.customer_code || '').trim();
        var cust = resolveCustomer(custCode, row);
        var custId = cust ? cust.id : null;
        var groupKey = (custId || custCode.toLowerCase() || '') + '\u0000' + dressType.toLowerCase();

        meaSeq++;
        var rec = groupKey in meaByKey ? meaByKey[groupKey] : null;
        if (!rec) {
          rec = {
            id: uuid(),
            code: '',
            dress_type: dressType,
            values: {}
          };
          var category = String(row.category || '').trim() || categoryFor(dressType);
          if (category) rec.category = category;
          if (custId) rec.customer_id = custId;
          var base = 'MEA-' + (cust ? String(cust.code || custCode) : ('X' + pad(meaSeq, 4))) +
            '-' + (dressType.replace(/[^A-Za-z0-9]+/g, '') || 'X');
          var code = base, n = 1;
          while (usedMeaCodes[code.toLowerCase()]) { n++; code = base + '-' + n; }
          usedMeaCodes[code.toLowerCase()] = true;
          rec.code = code;
          measurements.push(rec);
          meaByKey[groupKey] = rec;
        }
        if (row.notes) rec.notes = String(row.notes).trim();
        if (measure && String(row.value == null ? '' : row.value).trim() !== '') {
          rec.values[measure] = String(row.value).trim();
        }
      });
      for (var mi = measurements.length - 1; mi >= 0; mi--) {
        if (!Object.keys(measurements[mi].values).length) measurements.splice(mi, 1);
      }
      if (measurements.length) tables.measurements = measurements;
    }

    var os = findTable(sheets, 'orders');
    if (os) {
      var oh = splitHeader(os);
      var omap = headerMap(oh.header, ORDER_COLS);
      var orders = [], items = [], byId = {};
      oh.body.forEach(function (cells) {
        var row = pickRow(cells, omap);
        if (!anyValue(row)) return;

        var amount = String(row.amount == null ? '' : row.amount).trim() !== ''
          ? num(row.amount)
          : round(num(row.rate) * (num(row.quantity) || 1));
        var ocode = String(row.order_code || '').trim();

        var rec = ocode ? byId[ocode.toLowerCase()] : null;
        if (!rec) {
          ordSeq++;
          ocode = ocode || ('IMP-ORD-' + pad(ordSeq, 4));
          var custCode = String(row.customer_code || '').trim();
          rec = {
            id: uuid(),
            code: ocode,
            order_date: excelDate(row.order_date) || today(),
            status: status(row.status),
            priority: priority(row.priority),
            total: 0,
            discount: num(row.discount),
            advance: num(row.advance)
          };
          var ocust = resolveCustomer(custCode, row);
          if (ocust) rec.customer_id = ocust.id;
          if (row.delivery_date) rec.delivery_date = excelDate(row.delivery_date);
          if (row.notes) rec.notes = String(row.notes).trim();
          orders.push(rec);
          byId[ocode.toLowerCase()] = rec;
          orderByCode[ocode.toLowerCase()] = rec.id;
        }

        rec.total = round(rec.total + amount);
        rec.balance = round(rec.total - rec.discount - rec.advance);

        if (String(row.item || '').trim() !== '' || amount) {
          items.push({
            id: uuid(),
            order_id: rec.id,
            line_no: items.filter(function (it) { return it.order_id === rec.id; }).length + 1,
            category: '',
            dress_type: '',
            service: 'Tailoring',
            variant: String(row.item || '').trim(),
            lining: '',
            quantity: num(row.quantity) || 1,
            rate: num(row.rate),
            discount: 0,
            extra_charge: 0,
            line_total: amount,
            delivery_date: rec.delivery_date || ''
          });
        }
      });
      if (orders.length) {
        tables.orders = orders;
        tables.order_items = items;
      }
    }

    var ps = findTable(sheets, 'payments');
    if (ps) {
      var ph = splitHeader(ps);
      var pmap = headerMap(ph.header, PAYMENT_COLS);
      var payments = [];
      ph.body.forEach(function (cells) {
        var row = pickRow(cells, pmap);
        if (!anyValue(row)) return;
        paySeq++;
        var custCode = String(row.customer_code || '').trim();
        var orderCode = String(row.order_code || '').trim();
        var rec = {
          id: uuid(),
          code: String(row.payment_code || '').trim() || ('IMP-PAY-' + pad(paySeq, 4)),
          amount: num(row.amount),
          method: method(row.method)
        };
        var pcust = resolveCustomer(custCode, row);
        if (pcust) rec.customer_id = pcust.id;
        if (orderByCode[orderCode.toLowerCase()]) rec.order_id = orderByCode[orderCode.toLowerCase()];
        if (row.paid_on) rec.paid_on = excelDate(row.paid_on);
        if (row.notes) rec.notes = String(row.notes).trim();
        payments.push(rec);
      });
      if (payments.length) tables.payments = payments;
    }

    return tables;
  }

  // The customers already in the shop, keyed so a sheet row can find one by
  // code, mobile or name. Fetched before the workbook is read, so a row that
  // names an existing customer links to it instead of being dropped. A failure
  // here is not fatal: the import simply loses the fallback and matches only
  // within the file, which is how it behaved before.
  function loadKnown() {
    var empty = { byCode: {}, byMobile: {}, byName: {} };
    var sb = window.ANT && window.ANT.sb;
    if (!sb || !sb.from) return Promise.resolve(empty);
    return sb.from('customers').select('id,code,name,mobile').then(function (res) {
      if (res.error || !res.data) return empty;
      var known = { byCode: {}, byMobile: {}, byName: {} };
      res.data.forEach(function (c) {
        var id = c.id;
        var code = String(c.code == null ? '' : c.code).trim().toLowerCase();
        if (code && !known.byCode[code]) known.byCode[code] = { id: id, code: c.code };
        var mobile = String(c.mobile == null ? '' : c.mobile).replace(/\D/g, '');
        if (mobile && !known.byMobile[mobile]) known.byMobile[mobile] = { id: id, code: c.code };
        var name = String(c.name == null ? '' : c.name).trim().toLowerCase();
        if (name && !known.byName[name]) known.byName[name] = { id: id, code: c.code };
      });
      return known;
    }).catch(function () { return empty; });
  }

  // files: File objects, .xlsx only. Mirrors restore.readBackup's shape so the
  // Import tab can hand either reader's result to the same preview and run.
  function read(files) {
    var list = Array.prototype.slice.call(files);
    var sheets = [];
    var ignored = [];
    var names = [];

    return list.reduce(function (chain, f) {
      return chain.then(function () {
        var lower = (f.name || '').toLowerCase();
        if (!/\.xlsx$/.test(lower)) { ignored.push(f.name); return null; }
        return f.arrayBuffer().then(function (buf) {
          return window.ANT.zip.read(buf);
        }).then(function (entries) {
          workbookSheets(entries).forEach(function (s) { sheets.push(s); });
          names.push(f.name);
        });
      });
    }, Promise.resolve()).then(function () {
      return loadKnown();
    }).then(function (known) {
      var tables = buildTables(sheets, known);
      return { tables: tables, names: names, ignored: ignored };
    });
  }

  /* Writing the template -------------------------------------------------- */

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colRef(n) {
    var s = '';
    n += 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cell(ref, value) {
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
      xmlEsc(value) + '</t></is></c>';
  }

  function rowXml(index, values) {
    var cells = values.map(function (v, i) { return cell(colRef(i) + index, v); }).join('');
    return '<row r="' + index + '">' + cells + '</row>';
  }

  function sheetXml(sheet) {
    var labels = sheet.columns.map(function (c) { return c.label; });
    var rows = [rowXml(1, labels)];
    (sheet.rows || []).forEach(function (r, i) { rows.push(rowXml(i + 2, r)); });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + rows.join('') + '</sheetData></worksheet>';
  }

  function infoSheet() {
    var lines = [
      ['How to fill this template'],
      ['1. Fill the Customers sheet first. Give each customer a short Customer Code (like C001). You will use it on the other sheets.'],
      ['2. Measurements: one line per field, like Chest 40 and Waist 34. Lines with the same Customer Code and Dress Type become one measurement.'],
      ['3. Orders: put the Customer Code so the order is linked to the right person. One row is one item; repeat the same Order Code on each row to give one order several items.'],
      ['4. Payments: use the Customer Code, and the Order Code too if the payment is for a certain order.'],
      ['5. Dates: type them like 05-01-2026 or 2026-01-05. Amounts: plain numbers, no commas or rupee sign.'],
      ['6. Leave a Customer Code or Order Code blank and the app will make one for you, but then that row cannot be linked to anything.'],
      ['7. Save the file and upload it on Settings, Import, "Review file". Nothing already in the shop is changed.'],
      ['The sample rows are examples only. Delete them before you import, or leave them out.']
    ];
    return lines.map(function (r, i) { return rowXml(i + 1, r); }).join('');
  }

  function contentTypes(count) {
    var overrides = '';
    for (var i = 0; i < count; i++) {
      overrides += '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      overrides + '</Types>';
  }

  function rootRels() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
  }

  function workbookXml(names) {
    var sheets = names.map(function (n, i) {
      return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheets + '</sheets></workbook>';
  }

  function workbookRels(count) {
    var rels = '';
    for (var i = 0; i < count; i++) {
      rels += '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    }
    rels += '<Relationship Id="rIdStyles' + (count + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels + '</Relationships>';
  }

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  // The blank workbook the shop fills in. A "How to fill" sheet, then one sheet
  // per table in reading order, each with a header row and sample rows.
  function template() {
    var names = ['How to fill'].concat(SHEETS.map(function (s) { return s.title; }));
    var files = [
      { name: '[Content_Types].xml', data: contentTypes(names.length) },
      { name: '_rels/.rels', data: rootRels() },
      { name: 'xl/workbook.xml', data: workbookXml(names) },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(names.length) },
      { name: 'xl/styles.xml', data: stylesXml() },
      { name: 'xl/worksheets/sheet1.xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetData>' + infoSheet() + '</sheetData></worksheet>' }
    ];
    SHEETS.forEach(function (def, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 2) + '.xml',
        data: sheetXml(sampleSheet(def)) });
    });
    return window.ANT.zip.build(files);
  }

  function sampleSheet(def) {
    var rows = def.sampleRows || [def.cols.map(function (c) { return c.sample; })];
    return { columns: def.cols, rows: rows };
  }

  window.ANT = window.ANT || {};
  window.ANT.excel = {
    read: read,
    template: template,
    _cols: { customers: CUSTOMER_COLS, measurements: MEASUREMENT_COLS,
      orders: ORDER_COLS, payments: PAYMENT_COLS },
    _parse: { uuid: uuid, excelDate: excelDate, status: status, buildTables: buildTables }
  };
})();

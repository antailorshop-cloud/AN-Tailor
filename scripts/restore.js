/* Bringing the shop's records back in.
 *
 * The file this reads is the one the Backup tab writes: a zip of one CSV per
 * table, taken from this same schema, so each row already carries its own id and
 * the ids it points at. That is what makes a faithful restore possible - a
 * customer's measurements name the customer by id, and the id is in the file.
 *
 * Two rules, both chosen by the shop: rows are ADDED to what is already there
 * (nothing is replaced), and a row that already exists is SKIPPED rather than
 * touched. "Already exists" means the same id, or - when the ids differ but the
 * readable code matches - the same code. When a parent is skipped because its
 * code is already in use under a different id, the children that name the old id
 * are rewritten to the id that is actually there, so a restore into a shop that
 * already has some of the records still lines up.
 *
 * Staff sign-ins are deliberately left out. profiles.id is an auth.users row,
 * one per project, so recreating them from a file would either fail or hand out
 * accounts nobody can sign in to. The rest of the staff list is in the backup
 * for reference; only the business records and the owner's master data come back.
 */
(function () {
  var PAGE = 1000;
  var BATCH = 200;

  // Dependency order: a row is only read once everything it points at is in
  // place. resale_stock comes before order_items because a resale line names a
  // stock row. The three master-data tables are last, and independent.
  var TABLES = [
    { file: 'customers', table: 'customers', ident: 'id', code: 'code',
      fks: {}, fetch: ['id', 'code'] },

    { file: 'measurements', table: 'measurements', ident: 'id', code: 'code',
      fks: { customer_id: 'customers' }, json: ['values'], fetch: ['id', 'code'] },

    { file: 'resale_stock', table: 'resale_stock', ident: 'id', code: 'code',
      fks: {}, fetch: ['id', 'code'] },

    { file: 'orders', table: 'orders', ident: 'id', code: 'code',
      fks: { customer_id: 'customers', measurement_id: 'measurements' },
      fetch: ['id', 'code'] },

    { file: 'order_items', table: 'order_items', ident: 'id', code: null,
      fks: { order_id: 'orders', measurement_id: 'measurements', resale_item_id: 'resale_stock' },
      pair: ['order_id', 'line_no'], fetch: ['id', 'order_id', 'line_no'] },

    { file: 'bills', table: 'bills', ident: 'id', code: 'code',
      fks: { customer_id: 'customers' }, fetch: ['id', 'code'] },

    { file: 'bill_orders', table: 'bill_orders', ident: null, code: null,
      fks: { bill_id: 'bills', order_id: 'orders' },
      pair: ['bill_id', 'order_id'], fetch: ['bill_id', 'order_id'] },

    { file: 'payments', table: 'payments', ident: 'id', code: 'code',
      fks: { order_id: 'orders', customer_id: 'customers' }, fetch: ['id', 'code'] },

    { file: 'prices', table: 'prices', ident: 'id', code: 'code',
      fks: {}, fetch: ['id', 'code'] },

    { file: 'dress_types', table: 'dress_types', ident: 'id', code: null,
      fks: {}, pair: ['category', 'dress_type'], fetch: ['id', 'category', 'dress_type'] },

    { file: 'shop_settings', table: 'shop_settings', ident: null, code: null,
      key: 'key', fks: {}, fetch: ['key'] }
  ];

  function endsWith(s, suffix) {
    return s.length >= suffix.length && s.slice(s.length - suffix.length) === suffix;
  }

  function orderCol(def) {
    if (def.ident) return 'id';
    if (def.key) return def.key;
    if (def.pair) return def.pair[0];
    return null;
  }

  function pairKey(cols, row) {
    return cols.map(function (c) { return row[c] == null ? '' : row[c]; }).join('|');
  }

  /* CSV ---------------------------------------------------------------- */

  // The dialect the export writes: a header row, comma separated, quotes around
  // any field holding a comma, quote or line break, doubled quotes inside, CRLF
  // or LF between rows and a UTF-8 BOM up front.
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], field = '', inQuotes = false, i = 0;
    while (i < text.length) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    var header = rows.shift() || [];
    var out = rows.filter(function (r) {
      return !(r.length === 1 && r[0] === '');
    }).map(function (r) {
      var o = {};
      header.forEach(function (h, k) { o[h] = r[k] == null ? '' : r[k]; });
      return o;
    });
    return { cols: header, rows: out };
  }

  /* Reading the file --------------------------------------------------- */

  function absorb(tables, names, ignored, name, text) {
    var base = name.split('/').pop();
    if (!endsWith(base.toLowerCase(), '.csv')) { ignored.push(name); return; }
    var key = base.replace(/\.csv$/i, '');
    tables[key] = parseCsv(text).rows;
    names.push(key);
  }

  // files: an array of File (or anything with name + text()/arrayBuffer()).
  function readBackup(files) {
    var tables = {}, names = [], ignored = [];
    var list = Array.prototype.slice.call(files);

    return list.reduce(function (chain, f) {
      return chain.then(function () {
        var lower = (f.name || '').toLowerCase();
        if (endsWith(lower, '.zip')) {
          return f.arrayBuffer().then(function (buf) {
            return window.ANT.zip.read(buf);
          }).then(function (entries) {
            entries.forEach(function (e) {
              absorb(tables, names, ignored, e.name, new TextDecoder('utf-8').decode(e.data));
            });
          });
        }
        if (endsWith(lower, '.csv')) {
          return f.text().then(function (t) { absorb(tables, names, ignored, f.name, t); });
        }
        ignored.push(f.name);
        return null;
      });
    }, Promise.resolve()).then(function () {
      return { tables: tables, names: names, ignored: ignored };
    });
  }

  /* Planning ----------------------------------------------------------- */

  function fetchAll(def) {
    var out = [];
    var col = orderCol(def);
    function step(from) {
      var q = window.ANT.sb.from(def.table).select((def.fetch || ['*']).join(','));
      if (col) q = q.order(col, true);
      return q.range(from, from + PAGE - 1).then(function (res) {
        if (res.error) throw new Error(def.table + ': ' + (res.error.message || res.error));
        var rows = res.data || [];
        out = out.concat(rows);
        if (!rows.length) return out;
        return step(from + rows.length);
      });
    }
    return step(0);
  }

  // A cell turned into what the table wants: blanks are dropped entirely so the
  // column's own default applies (an empty numeric is null/0, not ""), a jsonb
  // column is parsed back from its JSON text, and a foreign key is rewritten to
  // the id the parent actually ended up with.
  function prepare(def, row, idMap) {
    var out = {};
    Object.keys(row).forEach(function (col) {
      var v = row[col];
      if (v === '' || v == null) return;
      out[col] = v;
    });
    Object.keys(def.fks || {}).forEach(function (col) {
      var map = idMap[def.fks[col]];
      if (out[col] && map && map[out[col]]) out[col] = map[out[col]];
    });
    (def.json || []).forEach(function (col) {
      if (typeof out[col] === 'string') {
        try { out[col] = JSON.parse(out[col]); } catch (e) { /* kept as text */ }
      }
    });
    return out;
  }

  // Works out, table by table, which rows are new and which are already there.
  // No writes happen here, so the caller can show the shop what it is about to do.
  function planAll(tables) {
    var idMap = {};
    var plan = [];

    return TABLES.reduce(function (chain, def) {
      return chain.then(function () {
        var rows = tables[def.file] || [];
        idMap[def.table] = idMap[def.table] || {};

        return fetchAll(def).then(function (existing) {
          var ids = {}, codes = {}, codeToId = {}, pairs = {}, keys = {};
          existing.forEach(function (r) {
            if (r.id != null) ids[r.id] = true;
            if (def.code && r[def.code] != null) {
              codes[r[def.code]] = true;
              codeToId[r[def.code]] = r.id;
            }
            if (def.pair) pairs[pairKey(def.pair, r)] = true;
            if (def.key) keys[r[def.key]] = true;
          });

          var add = [], skip = 0;
          rows.forEach(function (row) {
            var prepared = prepare(def, row, idMap);
            var dup = false, mapId = null;

            if (def.ident) {
              mapId = row.id || null;
              if (row.id && ids[row.id]) {
                dup = true;
              } else if (def.code && row[def.code] && codes[row[def.code]]) {
                dup = true;
                mapId = codeToId[row[def.code]];
              }
            } else if (def.code && row[def.code] && codes[row[def.code]]) {
              dup = true;
            }

            if (!dup && def.pair && pairs[pairKey(def.pair, row)]) dup = true;
            if (!dup && def.key && keys[row[def.key]]) dup = true;

            if (def.ident && mapId) idMap[def.table][row.id || mapId] = mapId;

            if (dup) skip++;
            else add.push(prepared);
          });

          plan.push({ def: def, found: rows.length, add: add, skip: skip, inserted: 0 });
        });
      });
    }, Promise.resolve()).then(function () {
      return plan;
    });
  }

  function summarize(plan, failures) {
    var totals = { found: 0, add: 0, skip: 0, inserted: 0, failed: failures ? failures.length : 0 };
    var rows = plan.map(function (p) {
      totals.found += p.found;
      totals.add += p.add.length;
      totals.skip += p.skip;
      totals.inserted += p.inserted;
      return { table: p.def.table, file: p.def.file, found: p.found,
        add: p.add.length, skip: p.skip, inserted: p.inserted };
    });
    return { tables: rows, totals: totals, failures: failures || [] };
  }

  function preview(tables) {
    return planAll(tables).then(function (plan) { return summarize(plan); });
  }

  /* Writing ------------------------------------------------------------ */

  function insertBatch(table, batch) {
    return window.ANT.sb.from(table).insert(batch).select('*').then(function (res) {
      if (res.error) throw res.error;
      return (res.data || []).length;
    });
  }

  // A batch that fails is retried one row at a time, so a single bad row is
  // reported and skipped rather than taking 199 good rows down with it.
  function insertRows(def, rows, failures) {
    var total = 0;
    function chunk(i) {
      if (i >= rows.length) return Promise.resolve(total);
      var batch = rows.slice(i, i + BATCH);
      return insertBatch(def.table, batch).then(function (n) {
        total += n;
        return chunk(i + BATCH);
      }).catch(function () {
        return batch.reduce(function (chain, row) {
          return chain.then(function () {
            return insertBatch(def.table, [row]).then(function (n) {
              total += n;
            }).catch(function (e) {
              failures.push({
                table: def.table,
                code: row.code || row.id || '',
                message: (e && (e.message || e.detail || e)) + ''
              });
            });
          });
        }, Promise.resolve()).then(function () { return chunk(i + BATCH); });
      });
    }
    return chunk(0);
  }

  function run(tables) {
    return planAll(tables).then(function (plan) {
      var failures = [];
      return plan.reduce(function (chain, p) {
        return chain.then(function () {
          if (!p.add.length) return null;
          return insertRows(p.def, p.add, failures).then(function (n) { p.inserted = n; });
        });
      }, Promise.resolve()).then(function () {
        return summarize(plan, failures);
      });
    });
  }

  window.ANT = window.ANT || {};
  window.ANT.restore = {
    parseCsv: parseCsv,
    readBackup: readBackup,
    preview: preview,
    run: run,
    tables: TABLES
  };
})();

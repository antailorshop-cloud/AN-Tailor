/* The Backup tab's PDF half: every object in the bill-pdfs bucket, downloaded
 * and handed back as one or more zip files. Kept out of export.js because a
 * database backup is small and quick, while an archive of years of bills has to
 * be walked a page at a time and split into pieces a phone can actually save.
 *
 * This file only reads. Nothing is removed from storage and no bill row is
 * touched: clearing the bucket is a separate, confirmed action in Settings. */
(function () {
  var PDF_BUCKET = 'bill-pdfs';
  var PAGE = 1000;
  var MAX_PAGES = 1000;
  var MAX_FILES = 500;
  var MAX_BYTES = 100 * 1024 * 1024;

  function sb() { return window.ANT.sb; }

  function progress(fn, value) {
    if (typeof fn !== 'function') return;
    try { fn(value); } catch (e) { /* A progress label must never stop a backup. */ }
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function stamp(d) {
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  function problem(err) {
    if (err && err.message) return err.message;
    return String(err || 'The PDF archive could not be made.');
  }

  /* Storage lists a page at a time, and the order has to be stable or an offset
   * can skip a file when objects are still being uploaded. Name order is cheap
   * and never changes while the archive is running. */
  function listAll(onProgress) {
    if (!sb() || !sb().storage) {
      return Promise.reject(new Error('PDF storage is not set up yet.'));
    }

    var bucket = sb().storage.from(PDF_BUCKET);
    var names = [];
    var page = 0;
    var guard = 0;

    function step() {
      if (guard++ >= MAX_PAGES) {
        return Promise.reject(new Error('There are too many PDFs to archive in one run.'));
      }

      return bucket.list('', {
        limit: PAGE,
        offset: page * PAGE,
        sortBy: { column: 'name', order: 'asc' }
      }).then(function (res) {
        if (res.error) throw new Error(problem(res.error));
        var rows = res.data || [];
        rows.forEach(function (f) {
          if (f && f.name) names.push(f.name);
        });
        page++;
        progress(onProgress, { phase: 'listing', listed: names.length, page: page });
        if (rows.length < PAGE) return names;
        return step();
      });
    }

    return step();
  }

  // Blob.arrayBuffer is present in every browser this app supports. The reader
  // is kept for an older WebView that has Blobs but not the newer method.
  function bytesOf(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      return blob.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read the PDF.')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  function fetchPdf(bucket, name) {
    return fetch(bucket.publicUrl(name), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error(name + ': ' + (res.statusText || res.status));
        return res.blob();
      })
      .then(function (blob) {
        return bytesOf(blob).then(function (bytes) {
          return {
            name: String(name).split('/').pop() || name,
            bytes: bytes,
            size: bytes.length
          };
        });
      });
  }

  // A real anchor click, the same way the database backup and WhatsApp links are
  // saved, so the app never navigates away from the Backup tab.
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

  // Several downloads fired in the same tick are blocked by some browsers. The
  // short gap gives each save time to start before the next one is asked for.
  function pause() {
    return new Promise(function (resolve) { setTimeout(resolve, 350); });
  }

  function flush(part, files, bytesProcessed, onProgress) {
    if (!files.length) return part;
    var blob = window.ANT.zip.build(files);
    var next = part + 1;
    var name = 'AN-Tailor-PDF-archive-' + stamp(new Date()) + '-' + two(next) + '.zip';
    save(blob, name);
    progress(onProgress, {
      phase: 'saving',
      part: next,
      files: files.length,
      bytes: bytesProcessed
    });
    return next;
  }

  /* Resolves with { files, bytes, parts }. `onProgress` is optional and is
   * called with listing, downloading and saving updates for the Backup tab. */
  function run(onProgress) {
    if (!window.ANT.zip) {
      return Promise.reject(new Error('ZIP writer is not available.'));
    }

    return listAll(onProgress).then(function (names) {
      var bucket = sb().storage.from(PDF_BUCKET);
      var state = { files: 0, bytes: 0, parts: 0, total: names.length };
      var current = [];
      var currentBytes = 0;

      progress(onProgress, {
        phase: 'downloading',
        done: 0,
        total: state.total,
        bytes: 0,
        part: 1
      });

      function step(i) {
        if (i >= names.length) {
          if (current.length) {
            state.parts = flush(state.parts, current, currentBytes, onProgress);
          }
          return {
            files: state.files,
            bytes: state.bytes,
            parts: state.parts
          };
        }

        return fetchPdf(bucket, names[i]).then(function (item) {
          var full = current.length >= MAX_FILES ||
            (current.length > 0 && currentBytes + item.size > MAX_BYTES);

          if (full) {
            state.parts = flush(state.parts, current, currentBytes, onProgress);
            return pause().then(function () {
              current = [];
              currentBytes = 0;
              add(item);
              return step(i + 1);
            });
          }

          add(item);
          return step(i + 1);
        });
      }

      function add(item) {
        current.push({ name: item.name, data: item.bytes });
        currentBytes += item.size;
        state.files++;
        state.bytes += item.size;
        progress(onProgress, {
          phase: 'downloading',
          done: state.files,
          total: state.total,
          bytes: state.bytes,
          part: state.parts + 1
        });
      }

      return step(0);
    }).catch(function (e) {
      return Promise.reject(new Error(problem(e)));
    });
  }

  window.ANT = window.ANT || {};
  window.ANT.pdfarchive = {
    run: run,
    listAll: listAll,
    limits: { files: MAX_FILES, bytes: MAX_BYTES }
  };
})();

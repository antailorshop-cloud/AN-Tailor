/* A very small ZIP writer, used by the Backup tab to hand the shop one file
 * instead of a dozen downloads (which phones refuse to start anyway). It stores
 * the files as they are - no compression - because CSV of shop records is small
 * and the code stays short enough to read. The format is the original PKZIP
 * one, which every unzip tool and both desktop and mobile OSes understand.
 *
 * Only what the writer needs is implemented: no encryption, no zip64, no data
 * descriptors. Every entry is small enough that its sizes and CRC are known
 * before it is written, so each local header can be filled in upfront.
 */
(function () {
  // The CRC-32 table, built once. This is the reflected polynomial every zip
  // uses (0xEDB88320).
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    var c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Text to UTF-8 bytes. TextEncoder covers every browser this app runs in;
  // the manual path is a fallback for the odd old WebView.
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    return utf8(String(data));
  }

  function push16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function push32(a, v) {
    a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
  }

  // Zip stores the date in the old MS-DOS packed form, with the year counted
  // from 1980 and the seconds in units of two.
  function dosStamp(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) |
      ((Math.floor(d.getSeconds() / 2)) & 31);
    var date = (((Math.max(1980, d.getFullYear()) - 1980) & 127) << 9) |
      (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  /* files: [{ name, data }] where data is a string or Uint8Array. Returns a
   * Blob of type application/zip. */
  function build(files, when) {
    var stamp = dosStamp(when || new Date());
    var parts = [];
    var central = [];
    var offset = 0;
    var count = 0;

    (files || []).forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = bytesOf(f.data);
      var crc = crc32(data);

      var local = [];
      push32(local, 0x04034B50);   // local file header signature
      push16(local, 20);           // version needed to extract
      push16(local, 0x0800);       // general purpose flag: names are UTF-8
      push16(local, 0);            // method: stored
      push16(local, stamp.time);
      push16(local, stamp.date);
      push32(local, crc);
      push32(local, data.length);  // compressed size (stored, so equal)
      push32(local, data.length);  // uncompressed size
      push16(local, nameBytes.length);
      push16(local, 0);            // extra field length
      var localHead = new Uint8Array(local);
      parts.push(localHead, nameBytes, data);

      var cd = [];
      push32(cd, 0x02014B50);      // central directory header signature
      push16(cd, 20);              // version made by
      push16(cd, 20);              // version needed
      push16(cd, 0x0800);
      push16(cd, 0);
      push16(cd, stamp.time);
      push16(cd, stamp.date);
      push32(cd, crc);
      push32(cd, data.length);
      push32(cd, data.length);
      push16(cd, nameBytes.length);
      push16(cd, 0);               // extra
      push16(cd, 0);               // comment
      push16(cd, 0);               // disk number start
      push16(cd, 0);               // internal attributes
      push32(cd, 0);               // external attributes
      push32(cd, offset);          // offset of the local header
      central.push(new Uint8Array(cd), nameBytes);

      offset += localHead.length + nameBytes.length + data.length;
      count++;
    });

    var centralStart = offset;
    var centralSize = 0;
    central.forEach(function (p) {
      parts.push(p);
      centralSize += p.length;
    });

    var end = [];
    push32(end, 0x06054B50);       // end of central directory signature
    push16(end, 0);                // disk number
    push16(end, 0);                // disk with the central directory
    push16(end, count);            // entries on this disk
    push16(end, count);            // entries in total
    push32(end, centralSize);
    push32(end, centralStart);
    push16(end, 0);                // comment length
    parts.push(new Uint8Array(end));

    return new Blob(parts, { type: 'application/zip' });
  }

  /* Reading ------------------------------------------------------------- */

  function u16(a, i) { return a[i] | (a[i + 1] << 8); }
  function u32(a, i) {
    return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
  }

  function findEOCD(a) {
    // The end-of-central-directory record is within the last 22 bytes plus the
    // optional comment, which is at most 65535. Search back for the signature.
    var min = Math.max(0, a.length - 22 - 65535);
    for (var i = a.length - 22; i >= min; i--) {
      if (u32(a, i) === 0x06054B50) return i;
    }
    return -1;
  }

  // Inflate a raw deflate stream (method 8) using the browser's own decoder.
  // Nothing here compresses, so most entries are stored; this only matters if
  // the zip came from somewhere else, such as a desktop "Compress" action.
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This zip is compressed and this browser cannot open it.'));
    }
    var stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) {
      return new Uint8Array(b);
    });
  }

  /* buffer: an ArrayBuffer. Resolves with [{ name, data: Uint8Array }]. */
  function read(buffer) {
    var bytes = new Uint8Array(buffer);
    var eocd = findEOCD(bytes);
    if (eocd < 0) return Promise.reject(new Error('That is not a zip file.'));

    var count = u16(bytes, eocd + 10);
    var p = u32(bytes, eocd + 16);   // offset of the central directory

    var jobs = [];
    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014B50) break;
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var localAt = u32(bytes, p + 42);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

      var dataAt = localAt + 30 + u16(bytes, localAt + 26) + u16(bytes, localAt + 28);
      var raw = bytes.subarray(dataAt, dataAt + compSize);

      (function (name, method, raw) {
        jobs.push((method === 0 ? Promise.resolve(raw) : inflateRaw(raw))
          .then(function (data) { return { name: name, data: data }; }));
      })(name, method, raw);

      p += 46 + nameLen + extraLen + commentLen;
    }

    return Promise.all(jobs);
  }

  window.ANT = window.ANT || {};
  window.ANT.zip = { build: build, read: read, crc32: crc32, utf8: utf8 };
})();

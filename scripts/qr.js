/* AN TAILOR - QR code encoder (byte mode), drawn as inline SVG.
 *
 * Written for the UPI code printed on a bill, but nothing here knows about
 * money. It turns a string into a standard QR symbol and returns it as SVG.
 *
 * The code is built in the browser from the text itself, with no outside
 * service and no image library. Drawing it as SVG rather than a PNG means the
 * bill needs no image encoder, the code stays sharp at any print size, and
 * nothing about the UPI id, the amount or the bill number is sent anywhere to
 * be turned into a picture.
 *
 * This is a port of the reference QR encoder by Project Nayuki
 * (https://www.nayuki.io/page/qr-code-generator-library), MIT licensed, trimmed
 * to what a UPI link needs: byte mode only and no automatic upgrade of the
 * error correction level. The algorithm and the tables are unchanged, so the
 * output is a standard ISO/IEC 18004 QR code.
 *
 *   Copyright (c) Project Nayuki. (MIT License)
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to
 *   deal in the Software without restriction, including without limitation the
 *   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 *   sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the conditions of the MIT licence as stated
 *   in the original library.
 */

window.ANT = window.ANT || {};

window.ANT.qr = (function () {
  /* Error correction levels. ordinal indexes the tables below; formatBits is
   * the two bit value written into the format area. Higher correction leaves
   * less room for data but survives a smudged or partly covered code, which is
   * why HIGH is the default for a printed bill. */
  var ECC_LOW = { ordinal: 0, formatBits: 1 };
  var ECC_MEDIUM = { ordinal: 1, formatBits: 0 };
  var ECC_QUARTILE = { ordinal: 2, formatBits: 3 };
  var ECC_HIGH = { ordinal: 3, formatBits: 2 };

  var MIN_VERSION = 1;
  var MAX_VERSION = 40;

  /* Penalties used to pick the least awkward looking mask. */
  var PENALTY_N1 = 3;
  var PENALTY_N2 = 3;
  var PENALTY_N3 = 40;
  var PENALTY_N4 = 10;

  /* Error correction codewords per block, indexed by [ecc.ordinal][version].
   * Index 0 of each row is padding and holds an illegal value. */
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];

  /* Number of error correction blocks, same indexing. */
  var NUM_EC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  /* Capacity ------------------------------------------------------------ */

  /* Number of data bits available once every function module is placed,
   * including the remainder bits. */
  function numRawDataModules(version) {
    if (version < MIN_VERSION || version > MAX_VERSION) {
      throw new Error('QR version out of range.');
    }

    var result = (16 * version + 128) * version + 64;

    if (version >= 2) {
      var numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }

    return result;
  }

  /* Data codewords left after the error correction is taken out. */
  function numDataCodewords(version, ecl) {
    return Math.floor(numRawDataModules(version) / 8) -
      (ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version] *
       NUM_EC_BLOCKS[ecl.ordinal][version]);
  }

  /* Byte mode stores the length in 8 bits up to version 9, 16 bits after. */
  function charCountBits(version) {
    return version <= 9 ? 8 : 16;
  }

  /* Reed-Solomon error correction --------------------------------------- */

  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  /* Generator polynomial for the given degree. */
  function rsComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw new Error('QR degree out of range.');

    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);

    var root = 1;
    for (var d = 0; d < degree; d++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  /* Error correction codewords for one block of data. */
  function rsComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });

    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= rsMultiply(coef, factor);
      });
    });

    return result;
  }

  /* Placement ----------------------------------------------------------- */

  /* Where the alignment patterns sit, on both axes. */
  function alignmentPatternPositions(version, size) {
    if (version === 1) return [];

    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    var result = [6];

    for (var pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  /* Encode -------------------------------------------------------------- */

  /* Returns { size, version, mask, modules } where modules is a grid of
   * true (dark) and false (light). */
  function encode(text, ecl) {
    var level = ecl || ECC_HIGH;
    var bytes = utf8Bytes(text);

    /* Smallest version that holds the payload at this correction level. */
    var version = 0;
    var usedBits = 0;

    for (version = MIN_VERSION; version <= MAX_VERSION; version++) {
      var capacityBits = numDataCodewords(version, level) * 8;
      var needed = 4 + charCountBits(version) + (bytes.length * 8);
      if (needed <= capacityBits) {
        usedBits = needed;
        break;
      }
    }

    if (!version || usedBits === 0) throw new Error('QR payload is too long.');

    var bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, charCountBits(version));
    bytes.forEach(function (b) { appendBits(bits, b, 8); });

    var capacity = numDataCodewords(version, level) * 8;
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

    for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) {
      appendBits(bits, pad, 8);
    }

    var dataCodewords = [];
    while (dataCodewords.length * 8 < bits.length) dataCodewords.push(0);
    bits.forEach(function (b, i) {
      dataCodewords[i >>> 3] |= b << (7 - (i & 7));
    });

    return build(version, level, dataCodewords);
  }

  function appendBits(buffer, value, length) {
    for (var i = length - 1; i >= 0; i--) {
      buffer.push((value >>> i) & 1);
    }
  }

  function utf8Bytes(text) {
    var out = [];
    var value = String(text == null ? '' : text);

    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);

      /* Join a surrogate pair back into one code point so anything outside
       * the basic plane survives. */
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length) {
        var next = value.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
        }
      }

      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code < 0x10000) {
        out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      } else {
        out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F),
          0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }

    return out;
  }

  /* Draw the symbol ----------------------------------------------------- */

  function build(version, ecl, dataCodewords) {
    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];

    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    var setFunction = function (x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };

    var getBit = function (x, i) { return ((x >>> i) & 1) !== 0; };

    /* Function patterns */
    for (var i = 0; i < size; i++) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }

    var drawFinder = function (cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var x = cx + dx;
          var yy = cy + dy;
          if (x >= 0 && x < size && yy >= 0 && yy < size) {
            setFunction(x, yy, dist !== 2 && dist !== 4);
          }
        }
      }
    };

    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    var alignPositions = alignmentPatternPositions(version, size);
    var numAlign = alignPositions.length;

    for (var ai = 0; ai < numAlign; ai++) {
      for (var aj = 0; aj < numAlign; aj++) {
        var onFinderCorner =
          (ai === 0 && aj === 0) ||
          (ai === 0 && aj === numAlign - 1) ||
          (ai === numAlign - 1 && aj === 0);
        if (onFinderCorner) continue;

        for (var ady = -2; ady <= 2; ady++) {
          for (var adx = -2; adx <= 2; adx++) {
            setFunction(
              alignPositions[ai] + adx,
              alignPositions[aj] + ady,
              Math.max(Math.abs(adx), Math.abs(ady)) !== 1
            );
          }
        }
      }
    }

    var drawFormatBits = function (mask) {
      var data = (ecl.formatBits << 3) | mask;
      var rem = data;
      for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var format = ((data << 10) | rem) ^ 0x5412;

      for (var a = 0; a <= 5; a++) setFunction(8, a, getBit(format, a));
      setFunction(8, 7, getBit(format, 6));
      setFunction(8, 8, getBit(format, 7));
      setFunction(7, 8, getBit(format, 8));
      for (var b = 9; b < 15; b++) setFunction(14 - b, 8, getBit(format, b));
      for (var c = 0; c < 8; c++) setFunction(size - 1 - c, 8, getBit(format, c));
      for (var d = 8; d < 15; d++) setFunction(8, size - 15 + d, getBit(format, d));
      setFunction(8, size - 8, true);
    };

    drawFormatBits(0);

    if (version >= 7) {
      var vrem = version;
      for (var vi = 0; vi < 12; vi++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1F25);
      var versionBits = (version << 12) | vrem;

      for (var vb = 0; vb < 18; vb++) {
        var dark = getBit(versionBits, vb);
        var va = size - 11 + (vb % 3);
        var vbb = Math.floor(vb / 3);
        setFunction(va, vbb, dark);
        setFunction(vbb, va, dark);
      }
    }

    /* Error correction and interleaving */
    var allCodewords = addEccAndInterleave(version, ecl, dataCodewords);

    /* Data placement */
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var yy2 = upward ? size - 1 - vert : vert;
          if (!isFunction[yy2][x] && idx < allCodewords.length * 8) {
            modules[yy2][x] = getBit(allCodewords[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    /* Masking */
    var applyMask = function (mask) {
      for (var my = 0; my < size; my++) {
        for (var mx = 0; mx < size; mx++) {
          var invert = false;
          if (mask === 0) invert = (mx + my) % 2 === 0;
          else if (mask === 1) invert = my % 2 === 0;
          else if (mask === 2) invert = mx % 3 === 0;
          else if (mask === 3) invert = (mx + my) % 3 === 0;
          else if (mask === 4) invert = (Math.floor(mx / 3) + Math.floor(my / 2)) % 2 === 0;
          else if (mask === 5) invert = (mx * my % 2) + (mx * my % 3) === 0;
          else if (mask === 6) invert = ((mx * my % 2) + (mx * my % 3)) % 2 === 0;
          else invert = (((mx + my) % 2) + (mx * my % 3)) % 2 === 0;

          if (!isFunction[my][mx] && invert) modules[my][mx] = !modules[my][mx];
        }
      }
    };

    var chosenMask = 0;
    var minPenalty = Infinity;

    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormatBits(m);
      var penalty = penaltyScore(modules, size);
      if (penalty < minPenalty) {
        minPenalty = penalty;
        chosenMask = m;
      }
      applyMask(m);
    }

    applyMask(chosenMask);
    drawFormatBits(chosenMask);

    return {
      size: size,
      version: version,
      mask: chosenMask,
      modules: modules,
      // Which modules are function patterns rather than data. The drawing code
      // ignores it; the test harness reads it back to prove the data placement,
      // masking and error correction independently.
      functionModules: isFunction
    };
  }

  function addEccAndInterleave(version, ecl, data) {
    var numBlocks = NUM_EC_BLOCKS[ecl.ordinal][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
    var rawCodewords = Math.floor(numRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsComputeDivisor(blockEccLen);
    var blocks = [];
    var k = 0;

    for (var b = 0; b < numBlocks; b++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (b < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsComputeRemainder(dat, divisor);
      if (b < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var p = 0; p < blocks[0].length; p++) {
      blocks.forEach(function (block, j) {
        if (p !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
          result.push(block[p]);
        }
      });
    }

    return result;
  }

  /* Mask penalty. Lower is easier for a scanner, so the mask that scores
   * lowest is the one kept. */
  function penaltyScore(modules, size) {
    var result = 0;

    var scoreLine = function (getter) {
      var lineScore = 0;
      var runColor = false;
      var runLength = 0;
      var history = [0, 0, 0, 0, 0, 0, 0];

      var addHistory = function (len) {
        if (history[0] === 0) len += size;
        history.pop();
        history.unshift(len);
      };

      var countPatterns = function () {
        var n = history[1];
        var core = n > 0 && history[2] === n && history[3] === n * 3 &&
          history[4] === n && history[5] === n;
        return ((core && history[0] >= n * 4 && history[6] >= n) ? 1 : 0) +
          ((core && history[6] >= n * 4 && history[0] >= n) ? 1 : 0);
      };

      for (var a = 0; a < size; a++) {
        if (getter(a) === runColor) {
          runLength++;
          if (runLength === 5) lineScore += PENALTY_N1;
          else if (runLength > 5) lineScore++;
        } else {
          addHistory(runLength);
          if (!runColor) lineScore += countPatterns() * PENALTY_N3;
          runColor = getter(a);
          runLength = 1;
        }
      }

      if (runColor) {
        addHistory(runLength);
        runLength = 0;
      }

      runLength += size;
      addHistory(runLength);
      lineScore += countPatterns() * PENALTY_N3;

      return lineScore;
    };

    for (var y = 0; y < size; y++) {
      result += scoreLine((function (yy) {
        return function (x) { return modules[yy][x]; };
      })(y));
    }

    for (var x = 0; x < size; x++) {
      result += scoreLine((function (xx) {
        return function (yy) { return modules[yy][xx]; };
      })(x));
    }

    for (var by = 0; by < size - 1; by++) {
      for (var bx = 0; bx < size - 1; bx++) {
        var color = modules[by][bx];
        if (color === modules[by][bx + 1] &&
            color === modules[by + 1][bx] &&
            color === modules[by + 1][bx + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    var dark = 0;
    modules.forEach(function (row) {
      dark += row.reduce(function (sum, c) { return sum + (c ? 1 : 0); }, 0);
    });

    var total = size * size;
    var kk = Math.ceil(Math.abs((dark * 20) - (total * 10)) / total) - 1;
    result += kk * PENALTY_N4;

    return result;
  }

  /* Output -------------------------------------------------------------- */

  /* Turns an encoded symbol into inline SVG. Every run of dark modules becomes
   * one rectangle in a single path, so the markup stays small, and crispEdges
   * keeps the module edges sharp when the bill is scaled down for A5. */
  function svg(text, options) {
    var opts = options || {};
    var code = encode(text, opts.ecl);

    var border = opts.border == null ? 2 : opts.border;
    var side = code.size + (2 * border);
    var dark = opts.dark || '#0f2239';
    var light = opts.light || '#ffffff';

    var escape = window.ANT.escapeHtml || function (v) { return String(v == null ? '' : v); };
    var label = opts.label
      ? ' aria-label="' + escape(opts.label) + '" role="img"'
      : ' aria-hidden="true"';

    var parts = [];

    for (var y = 0; y < code.size; y++) {
      var runStart = -1;

      for (var x = 0; x <= code.size; x++) {
        var isDark = x < code.size && code.modules[y][x];

        if (isDark && runStart < 0) runStart = x;

        if (!isDark && runStart >= 0) {
          parts.push('M' + (runStart + border) + ' ' + (y + border) +
            'h' + (x - runStart) + 'v1h-' + (x - runStart) + 'z');
          runStart = -1;
        }
      }
    }

    // width and height are given as well as viewBox. html2canvas, which the
    // shared PDF is rendered with, cannot size an SVG from viewBox alone and
    // draws nothing at all without them, so the code would vanish from the PDF
    // while still showing on screen. The CSS width/height still decide how big
    // it is drawn; these only give the element an intrinsic size.
    return '<svg class="' + (opts.className || 'qr-svg') + '"' +
      ' xmlns="http://www.w3.org/2000/svg"' +
      ' width="' + side + '" height="' + side + '"' +
      ' viewBox="0 0 ' + side + ' ' + side + '"' +
      ' shape-rendering="crispEdges"' +
      ' preserveAspectRatio="xMidYMid meet"' +
      label + '>' +
      '<rect width="' + side + '" height="' + side + '" fill="' + light + '"/>' +
      '<path fill="' + dark + '" d="' + parts.join('') + '"/>' +
      '</svg>';
  }

  return {
    matrix: encode,
    svg: svg,
    ecc: {
      low: ECC_LOW,
      medium: ECC_MEDIUM,
      quartile: ECC_QUARTILE,
      high: ECC_HIGH
    }
  };
})();

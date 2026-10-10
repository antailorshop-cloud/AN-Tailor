/* The bill PDF, drawn from the printed bill.
 *
 * There is exactly one description of what a bill looks like in this app, and it
 * is the printed one: PRINT_CSS and the markup bills.js builds. This file does
 * not restate any of it. It puts that markup in a hidden page the width of the
 * chosen sheet, lets the browser lay it out, and then draws what the browser
 * measured - every box, every line of text, every colour, size, weight and
 * letter-spacing straight off the live element.
 *
 * That is the whole point. A second hand-written copy of the layout - which is
 * what this file used to be - is a thing that agrees with the print until the day
 * somebody edits the stylesheet, and then it disagrees quietly: a panel a couple
 * of millimetres short, a caption a size out, a remark that never reaches the
 * page. Reading the numbers off the DOM means a printed bill and a shared PDF
 * are the same drawing, not two that resemble each other.
 *
 * What cannot be carried across is the typeface. jsPDF's built-in fonts are the
 * standard fourteen, so "Segoe UI" and Georgia are stood in by Helvetica and
 * Times. Sizes, weights, spacing, colours, alignment and position are all exact,
 * because they are measured rather than chosen; only the shapes of the letters
 * differ. Fitting a font file would triple the size of every bill to change that.
 *
 * The library is fetched on first use rather than with the page, so a shop phone
 * on a weak connection does not download it before it can open a bill.
 */
window.ANT = window.ANT || {};

window.ANT.billpdf = (function () {
  'use strict';

  var LIB = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  /* One css pixel is 1/96 of an inch, and a millimetre is 25.4 of them. */
  var MM = 25.4 / 96;
  var PT = 25.4 / 72;

  var SANS = 'helvetica';
  var SERIF = 'times';

  var loading = null;

  /* Saying something to the tailor, through the app's own toast where there is one.
   * Rendering a document has no business failing silently - a tailor who pressed
   * print and saw nothing at all would press it again - and this file is also
   * loaded on pages that have no toast of their own. */
  var toast = function (message, kind) {
    var say = window.ANT && window.ANT.toast;
    if (typeof say === 'function') say(message, kind);
  };

/* How many rupee signs the last bill drew. The sign cannot be found in the
 * finished file by looking for it - it is four strokes among a few hundred rules,
 * all of the same handful of colours - so it is counted as it is drawn and the
 * harness reads it here. */
var signsDrawn = 0;

  /* The payment stamp's own box, in the same page coordinates everything else in
   * the walk is measured in, as of the last bill drawn.
   *
   * It is kept rather than asked for again because a turned element cannot report
   * its own box: a bounding box around a tilted stamp is larger than the stamp, and
   * is what the browser hands back for any element with a transform on it. So the
   * stamp is put down for a moment and measured flat, and that is the only box that
   * is the stamp. A harness compares the letters the file wrote against this, which
   * is the only way to tell that the two agree - the page and the file set the
   * stamp in different fonts, so a label can be centred on the page and still sit
   * against one side of the box in the printed file. */
  var stampFlat = null;

  function library() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (loading) return loading;

    loading = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = LIB;
      tag.onload = function () {
        if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error('the pdf library did not load'));
      };
      tag.onerror = function () { reject(new Error('the pdf library could not be reached')); };
      document.head.appendChild(tag);
    });

    return loading;
  }

  /* The sheets, from printsize.js - the same three the printer is offered. */
  function sheetFor(key) {
    var k = String(key == null ? '' : key).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k === 'A5') return { w: 148, h: 210, portrait: true };
    if (k === 'A4HALF' || k === 'HALF') return { w: 297, h: 210, portrait: false };
    return { w: 210, h: 297, portrait: true };
  }

  /* How much paper a bill may occupy on this sheet, in millimetres: the printable
   * width on an ordinary sheet, and on a half sheet only the space between the left
   * margin and the cut line down the middle.
   *
   * Zero means "no half sheet", which is how outline() is told the difference without
   * being told the size - the caller knows the sheet and this works out what the
   * sheet means for the bill sitting on it. */
  function halfRoom(sheet) {
    if (!sheet || sheet.portrait) return 0;
    return sheet.w / 2 - window.ANT.printsize.GAP_MM;
  }

  function px(v) { return v * MM; }

  /* ------------------------------------------------------------------ stage
   * The printed document, laid out somewhere it can be measured. An iframe is
   * used rather than a detached element because the stylesheet is a full
   * document's worth of CSS with its own @page rule, and because an iframe gets
   * its own layout without anything else on the shop's screen moving.
   */
  function stage(html, widthMm) {
    return new Promise(function (resolve, reject) {
      var frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:' +
        Math.round(widthMm / MM) + 'px;height:2000px;border:0';

      /* Off the left edge of the screen, but drawn.
       *
       * This frame is measured for the PDF and printed for the page, and those two
       * want opposite things from it. Put far enough left to be off-screen and it
       * still lays out and still has computed styles, which is all measuring needs,
       * and it cannot flash on the tailor's screen while it works.
       *
       * It used to be marked visibility:hidden as well, which measuring did not
       * need and printing cannot have: a browser does not print content it has been
       * told is invisible, so the bill went to the printer as a sheet of nothing.
       * There is no need to hide it - -10000px is already nowhere near the screen. */

      /* The frame comes back still attached and is taken down by the caller once
       * it has finished reading. A document whose frame has gone has no window,
       * and without a window there are no computed styles - so detaching it early
       * would quietly take away the measurements that are the reason for doing
       * this at all. */
      function release() {
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      }

      /* Takes a picture out of the document so the bill is measured without it.
     * A broken image still has the box the stylesheet gave it, and leaving that
     * empty gold frame on the letterhead would be worse than no logo at all. */
    function dropPicture(img) {
      if (img && img.parentNode) img.parentNode.removeChild(img);
    }

      var settled = false;
      var loaded = false;
      var finished = null;

      /* One deadline for the whole job: the document arriving, its fonts, and
       * its pictures. A bill that cannot be produced because a logo is slow is a
       * worse bill than one with no logo on it, so when the wait runs out the
       * pictures still in flight are dropped and the rest is measured as it
       * stands, rather than the whole document being thrown away. */
      function settle(doc) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(doc ? { doc: doc, frame: frame, release: release } : null);
      }

      var deadline = setTimeout(function () {
        if (finished) {
          [].slice.call(finished.images || []).forEach(function (img) {
            if (!img.complete) dropPicture(img);
          });
        }
        settle(finished);
      }, 4000);

      frame.onload = function () {
        if (loaded) return;
        loaded = true;

        var doc = frame.contentDocument;
        finished = doc;

        var go = function () {
          // Fonts change every measurement on the page, so they are waited for
          // before anything is read rather than after.
          var waiting = doc.fonts && doc.fonts.ready && doc.fonts.ready.then
            ? doc.fonts.ready
            : Promise.resolve();

          waiting.then(function () { settle(doc); }, function () { settle(doc); });
        };

        /* Every picture the bill has, waited for together.
         *
         * A document reports itself loaded while a picture in it is still on the
         * wire, and measuring at that moment puts an empty gold frame on the
         * letterhead - a bill with no shop mark on it, which is the difference
         * between a letterhead and a sheet of text. Only the pictures that are
         * genuinely unfinished are waited on, and all of them at once: looking at
         * the first one and then looking again is how this fails on and off
         * rather than every time, which is the hardest kind of fault to catch. */
        var inFlight = [].slice.call(doc.images || []).filter(function (img) {
          return !img.complete;
        });

        if (!inFlight.length) { go(); return; }

        var left = inFlight.length;
        var arrived = function () { if (--left <= 0) go(); };

        inFlight.forEach(function (img) {
          img.addEventListener('load', arrived, { once: true });
          // A picture that has failed is a picture that is not there. Waiting on
          // a load that will never fire would leave the customer without a bill
          // over a missing letterhead.
          img.addEventListener('error', function () {
            dropPicture(img);
            arrived();
          }, { once: true });
        });
      };

      (document.body || document.documentElement).appendChild(frame);
      var doc = frame.contentDocument;
      doc.open();
      doc.write(html);
      doc.close();
    });
  }

  /* ----------------------------------------------------------------- colour */
  /* Colours arrive in two forms: rgb() from the browser's own reading of a
   * stylesheet, and the hex a picture writes on its own shapes. Both mean the
   * same colour and both have to be understood, or a rule written as a hex in a
   * picture is quietly left out of the page. */
  function colour(value) {
    if (!value) return null;

    var hex = /^#([\da-f]{3,8})$/i.exec(String(value).trim());
    if (hex) {
      var h = hex[1];
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      if (h.length !== 6 && h.length !== 8) return null;
      if (h.length === 8 && parseInt(h.slice(6, 8), 16) === 0) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }

    var m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function visible(el, style) {
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  /* The four rotation values the bill uses, read off the element rather than
   * assumed, so a stylesheet that turns the stamp or a corner the other way is
   * followed rather than argued with. */
  function angleOf(style) {
    var t = style.transform;
    if (!t || t === 'none') return 0;

    var m = /matrix\(([^)]+)\)/.exec(t);
    if (!m) return 0;

    var n = m[1].split(',').map(Number);
    // b and c are the sine and cosine of the rotation, in degrees anticlockwise.
    return Math.round(Math.atan2(n[1], n[0]) * 180 / Math.PI);
  }

  /* --------------------------------------------------------------- measuring
   * Walks the laid-out document and hands back everything needed to draw it,
   * in millimetres measured from the top left of the bill.
   */
  function outline(doc, halfRoom) {
    var bill = doc.querySelector('.bill');
    if (!bill) return null;

    /* The cut line on a half sheet is drawn down the middle of the paper, so half of
     * it is not the bill's to use. On every other sheet there is no cut and the bill
     * may have the whole printable width. */
    var root = doc.querySelector('.bill-half') || bill;
    var origin = bill.getBoundingClientRect();
    var view = doc.defaultView;
    var ops = [];

    /* The staged document is an iframe, and an iframe has no @page rule, so the
     * margin the printer obeys has to be added here instead - otherwise the PDF
     * is laid out to the edge of the paper while the print it is a copy of was
     * not, which is the whole difference this file exists to remove.
     *
     * It is taken off the origin rather than added to each measurement, so that
     * every coordinate below is already measured from a point outside the frame
     * and there is one number to keep right instead of one per measurement. */
    var GAP = window.ANT.printsize.GAP_MM;

/* On a half sheet the bill is moved off the left margin so that it is centred in
     * the half of the sheet that belongs to it, rather than shoved against the cut.
     *
     * The half-sheet rule in the stylesheet says roughly this with margin-left, and
     * here it has to be worked out, because this file measures from the bill's own
     * left edge: the bill is by definition at zero on that origin, and whatever the
     * stylesheet did to it on the page is thrown away with the frame it was measured
     * in.
     *
     * It cannot be a fixed number either. fit() narrows the frame to what the bill
     * actually needs, so a three-item bill is drawn narrower than a nine-item one and
     * the two must both come out centred. HalfRoom is how many millimetres of paper
     * the bill has to sit in; the bill is given the same white space on either side
     * of what is left over.
     *
     * A4 and A5 pass no room at all, and need none: their bills are exactly as wide
     * as the printable area, so they are already centred across the paper. */
    /* Half the leftover paper, in the pixels the origin is measured in, so that it can
       * be subtracted from it. Measured in millimetres first because halfRoom and the
       * bill's width are both in millimetres, and because dividing a pixel figure by
       * MM multiplies it by nearly four - the sort of thing that makes a bill 527mm
       * wide and quietly never moves. */
    var billWideMm = origin.width * MM;
    var spare = halfRoom ? Math.max(0, (halfRoom - billWideMm) / 2) : 0;
    var ox = origin.left - GAP / MM - spare / MM;
    var oy = origin.top - GAP / MM;

    function box(el) {
      var r = el.getBoundingClientRect();
      return {
        x: px(r.left - ox),
        y: px(r.top - oy),
        w: px(r.width),
        h: px(r.height)
      };
    }

    /* The font's own ascent and descent, so a baseline can be found inside a
     * line box. A canvas reports them for any font the browser has, which is the
     * one measurement jsPDF cannot make for us. */
    var scratch = doc.createElement('canvas').getContext('2d');
    function metrics(font) {
      scratch.font = font;
      var m = scratch.measureText('Hxg');
      return {
        ascent: m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 0,
        descent: m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 0
      };
    }

    /* Which of jsPDF's two families stands in for this one.
     *
     * Only the first name in the list can be the font actually in use - the rest
     * are fallbacks for fonts nobody has - so that is the one tested. The trap is
     * that "sans-serif" ends in "serif", and a test for the serif family run over
     * the whole list would hand every heading in the bill to Times. */
    function familyOf(list) {
      var first = String(list || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
      if (first === 'sans-serif') return SANS;
      return /georgia|times|garamond|book|cambria|constantia|palatino|bookman|serif/.test(first)
        ? SERIF
        : SANS;
    }

    function weightIsBold(style) {
      var w = style.fontWeight;
      return w === 'bold' || w === 'bolder' || Number(w) >= 600;
    }

    function transformed(text, how) {
      if (how === 'uppercase') return text.toUpperCase();
      if (how === 'lowercase') return text.toLowerCase();
      if (how === 'capitalize') return text.replace(/\b\p{L}/gu, function (c) {
        return c.toUpperCase();
      });
      return text;
    }

    /* One line of text, from a run of characters the browser put on the same
     * line. The browser is asked character by character rather than handed the
     * whole paragraph, because where it broke the line and how far each line
     * reaches is exactly what has to be reproduced, and it is the only thing that
     * knows. */
    function textRuns(el, style) {
      var out = [];
      var nodes = [];
      for (var i = 0; i < el.childNodes.length; i++) {
        var node = el.childNodes[i];
        if (node.nodeType === 3 && node.nodeValue) nodes.push(node);
      }
      if (!nodes.length) return out;

      var size = parseFloat(style.fontSize);
      var lead = style.lineHeight === 'normal' ? size * 1.2 : parseFloat(style.lineHeight);
      var gap = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing);
      var how = style.textTransform;
      var ink = colour(style.color);
      var align = style.textAlign;
      var font = familyOf(style.fontFamily);
      var bold = weightIsBold(style);
      var m = metrics(style.fontFamily + ' ' + style.fontWeight + ' ' + size + 'px');

      nodes.forEach(function (node) {
        var text = node.nodeValue.replace(/\s+/g, ' ');
        if (!text.trim()) return;

        var range = doc.createRange();
        var chars = Array.from(text);
        var line = null;
        var lines = [];

        function flush() {
          if (line && line.text.trim()) lines.push(line);
          line = null;
        }

        chars.forEach(function (ch, k) {
          range.setStart(node, k);
          range.setEnd(node, k + 1);

          var rects = range.getClientRects();
          var r = rects[rects.length - 1];
          if (!r || !r.width) return;

          var top = Math.round(r.top * 2) / 2;
          if (!line || line.top !== top) {
            flush();
            line = { top: top, bottom: r.bottom, left: r.left, right: r.right, text: '', rupee: 0 };
          }
          line.text += ch;
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
          line.bottom = Math.max(line.bottom, r.bottom);

          // How far the rupee sign itself advances is the browser's answer and
          // not ours. It is the width of the one character, and the drawing puts
          // its sign in exactly the space the print left for it.
          if (ch === '₹') line.rupee += r.width;
        });

        flush();
        range.detach && range.detach();

        lines.forEach(function (one) {
          // Half-leading is split evenly above and below the text by the line box,
          // so the baseline sits half of it down from the top of the box.
          var halfLead = (lead - (m.ascent + m.descent)) / 2;

          out.push({
            kind: 'text',
            text: transformed(one.text, how),
            left: px(one.left - ox),
            right: px(one.right - ox),
            baseline: px(one.top - oy) + px(halfLead + m.ascent),
            // The stylesheet speaks in pixels and the file speaks in points, and the
      // two are not the same number: a 10px heading is 7.5pt, not 10pt and not
      // 3.5. Converting through millimetres - which is what the rest of the
      // drawing is measured in - is px * MM to reach mm, then / PT to reach pt.
      // Getting this wrong scales every word on the bill by the same factor, so
      // it never looks like one mistake; it looks like a bill set in the wrong
      // size, on the printed page and in the file alike.
      size: (size * MM) / PT,
            gap: px(gap),
            align: align,
            ink: ink,
            font: font,
            // The whole stack, not the one family the drawing falls back to. A
            // canvas asked for 'Segoe UI, sans-serif' picks its rupee sign out of
            // the same list the page did, and one asked only for 'sans-serif'
            // picks whichever face happens to be the generic default - which on a
            // phone is not the face the customer just saw printed.
            stack: style.fontFamily,
            bold: bold,
            underline: style.textDecorationLine === 'underline' ||
              style.textDecoration.indexOf('underline') > -1,
            link: el.tagName === 'A' ? el.getAttribute('href') : '',
            rupee: one.rupee ? px(one.rupee) : 0
          });
        });
      });

      return out;
    }

    /* A qr code is a path of horizontal runs in viewBox units, one per dark
     * module. Drawn as rectangles it stays sharp at any zoom and costs a few
     * hundred bytes, where a picture of the same code costs tens of kilobytes. */
    function vectorPath(el, style, b, out) {
      var svg = el.querySelector('svg') || (el.tagName.toLowerCase() === 'svg' ? el : null);
      if (!svg) return false;

      var view = svg.getAttribute('viewBox');
      if (!view) return false;

      var v = view.split(/\s+/).map(Number);
      var scale = b.w / v[2];
      var svgStyle = getComputedStyle(svg);

      /* A picture states its colour once and its children say nothing, or states
       * it on the child and says nothing itself. Both are read, so a border round
       * an inline picture is drawn whether it was written on the picture or on the
       * shape inside it. */
      var inheritFill = colour(style.fill) || colour(svgStyle.fill);
      var inheritStroke = colour(svg.getAttribute('stroke')) || colour(svgStyle.stroke);
      var inheritWidth = parseFloat(svg.getAttribute('stroke-width'));
      if (isNaN(inheritWidth)) inheritWidth = parseFloat(svgStyle.strokeWidth);

      /* A stroke is given in the picture's own units and has to cross into the
       * page's, then back out again into the css pixels the border styles are
       * measured in, so that a rule round an inline picture lands on the same
       * weight as a rule round a div. */
      var rule = function (node) {
        if (node.getAttribute('stroke') === 'none') return null;
        var c = colour(node.getAttribute('stroke')) || inheritStroke;
        var w = parseFloat(node.getAttribute('stroke-width'));
        if (isNaN(w)) w = inheritWidth;
        if (!c || !w || isNaN(w)) return null;
        return { ink: c, w: (w * scale) / MM };
      };

      var solid = function (node) {
        if (node.getAttribute('fill') === 'none') return null;
        return colour(node.getAttribute('fill')) || inheritFill;
      };

      var drew = false;

      svg.querySelectorAll('rect').forEach(function (node) {
        var x = parseFloat(node.getAttribute('x'));
        var y = parseFloat(node.getAttribute('y'));
        var w = parseFloat(node.getAttribute('width'));
        var h = parseFloat(node.getAttribute('height'));
        if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h) || w <= 0 || h <= 0) return;

        var bg = rule(node);
        var inked = solid(node);
        if (!bg && !inked) return;

        out.push({
          kind: 'shape',
          box: {
            x: b.x + (x - v[0]) * scale,
            y: b.y + (y - v[1]) * scale,
            w: w * scale,
            h: h * scale
          },
          fill: bg ? null : inked,
          sides: bg ? ['Top', 'Right', 'Bottom', 'Left'].map(function () {
            return { ink: bg.ink, w: bg.w, kind: 'solid' };
          }) : null,
          radius: (parseFloat(node.getAttribute('rx')) || 0) * scale,
          angle: 0
        });
        drew = true;
      });

      svg.querySelectorAll('circle').forEach(function (node) {
        var cx = parseFloat(node.getAttribute('cx'));
        var cy = parseFloat(node.getAttribute('cy'));
        var r = parseFloat(node.getAttribute('r'));
        if (isNaN(cx) || isNaN(cy) || isNaN(r)) return;

        var bg = rule(node);
        var inked = solid(node);
        if (!bg && !inked) return;

        /* Sixteen sides is more than a circle this small needs to look round, and
         * each one costs a pair of numbers rather than a whole font. */
        var points = [];
        for (var i = 0; i < 16; i++) {
          var a = i * Math.PI / 8;
          points.push({
            x: b.x + (cx - v[0] + Math.cos(a) * r) * scale,
            y: b.y + (cy - v[1] + Math.sin(a) * r) * scale
          });
        }

        out.push({
          kind: 'path',
          points: points,
          fill: bg ? null : inked,
          ink: bg ? bg.ink : null,
          w: bg ? bg.w * MM : 0
        });
        drew = true;
      });

      svg.querySelectorAll('path').forEach(function (path) {
        var d = path.getAttribute('d') || '';
        var run = /M\s*([\d.-]+)\s+([\d.-]+)\s*h\s*([\d.-]+)\s*v\s*([\d.-]+)\s*h-([\d.-]+)\s*z/g;
        var ink = solid(path) || inheritFill || [0, 0, 0];
        var m;
        while ((m = run.exec(d))) {
          var rw = parseFloat(m[3]) * scale;
          var rh = parseFloat(m[4]) * scale;
          if (isNaN(rw) || isNaN(rh) || rw <= 0 || rh <= 0) continue;

          out.push({
            kind: 'fill',
            x: b.x + (parseFloat(m[1]) - v[0]) * scale,
            y: b.y + (parseFloat(m[2]) - v[1]) * scale,
            w: rw,
            h: rh,
            ink: ink
          });
          drew = true;
        }
      });

      return drew;
    }

    /* An element the browser lifts off the page - anything positioned, or given
     * a z-index - is not painted where it sits in the document. It goes on after
     * the text that flows around it, which is why the status stamp lands on top of
     * the totals instead of underlining them. */
    function raised(style) {
      if (style.position === 'absolute' || style.position === 'fixed') return true;
      var z = parseInt(style.zIndex, 10);
      return !isNaN(z) && z > 0;
    }

    /* Everything one element contributes to the drawing. */
    function emit(el, style, sink) {
      var b = box(el);
      if (b.w <= 0 || b.h <= 0) return;

      var angle = angleOf(style);

      if (el.tagName === 'IMG') {
        /* A picture that has not arrived yet is still a picture that belongs on the
         * page. Leaving it out here prints a letterhead with no shop mark on it, and
         * only on the first document after a restart or a cold cache - so it is the
         * kind of fault that looks like it works, most of the time. bitmap() takes
         * the element when the browser has decoded it and fetches the file when it
         * has not, so the picture is handed on either way and only a picture that is
         * genuinely not there goes missing. */
        if (el.getAttribute('src')) {
          sink.push({ kind: 'image', src: el.src, el: el, box: b, angle: angle });
        }
        return;
      }

      /* Only a picture is drawn as a picture. An element that merely holds one -
       * the bill holds two qr codes and a glyph - is walked through instead, or it
       * would swallow the whole bill the first time something inside it turned out
       * to be drawable. */
      if (el.tagName.toLowerCase() === 'svg') {
        // Turned out of the way first, because the bounding box of a turned
        // element is bigger than the element and would throw the code out of
        // its plate.
        var restore = style.transform;
        el.style.transform = 'none';
        b = box(el);
        var drew = vectorPath(el, style, b, sink);
        el.style.transform = restore;
        if (drew) return;
        b = box(el);
      }

      var fill = colour(style.backgroundColor);
      var sides = ['Top', 'Right', 'Bottom', 'Left'].map(function (side) {
        return {
          ink: colour(style['border' + side + 'Color']),
          w: parseFloat(style['border' + side + 'Width']) || 0,
          kind: style['border' + side + 'Style']
        };
      });

      var radius = parseFloat(style.borderTopLeftRadius) || 0;
      if (fill || sides.some(function (s) { return s.ink && s.w; })) {
        /* A turned shape is measured lying down for the same reason turned text
         * is. The browser's box for a turned element is the axis-aligned box that
         * encloses it, which is longer than the element in both directions; a
         * border drawn round that box and then turned again would come out twice
         * turned and much too large. Measured flat, the turn about the middle
         * that shape() applies puts every corner back where the browser has it. */
        var flatBox = b;
        if (angle) {
          var put = el.style.transform;
          el.style.transform = 'none';
          flatBox = box(el);
          el.style.transform = put;
        }

        sink.push({
          kind: 'shape',
          box: flatBox,
          fill: fill,
          sides: sides,
          radius: isNaN(radius) ? 0 : radius,
          angle: angle
        });
      }

      /* The gold frame inside the edge of the bill is a ::before, not an element,
       * so the walk never reaches it. Anything the stylesheet pins to its parent
       * can be placed without the browser - which is all the bill asks for, and
       * all that is drawn rather than quietly skipped. */
      ['::before', '::after'].forEach(function (which) {
        var s = view.getComputedStyle(el, which);
        if (!s || s.content === 'none' || !visible(el, s) || s.display === 'none') return;
        if (s.position !== 'absolute' && s.position !== 'fixed') return;

        /* A bill too tall for its sheet is shrunk by fitToOnePage, so its
         * measured box is in the zoomed space while every value read back off
         * the computed style is in the unzoomed one. Left unscaled those insets
         * describe a frame the size of the original bill, which is drawn on top
         * of the shrunk one and runs off its right edge and off the page. The
         * zoom is the ratio of the two boxes, and brings them back together. */
        var z = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
        if (!(z > 0)) z = 1;

        var pin = function (v) { var n = parseFloat(v); return isNaN(n) ? null : px(n * z); };

        /* An absolute box is placed against the padding box of the element it
         * hangs from, not its border box, so the border is taken off first. */
        var outer = box(el);
        var bl = px((parseFloat(style.borderLeftWidth) || 0) * z);
        var bt = px((parseFloat(style.borderTopWidth) || 0) * z);
        var br = px((parseFloat(style.borderRightWidth) || 0) * z);
        var bb = px((parseFloat(style.borderBottomWidth) || 0) * z);
        var frame = {
          x: outer.x + bl,
          y: outer.y + bt,
          w: outer.w - bl - br,
          h: outer.h - bt - bb
        };

        /* Both edges and a size are four answers to two questions. An edge is a
         * distance in from the side it names, which is why the width is what is
         * left over between them rather than the right-hand value itself. */
        var left = pin(s.left), right = pin(s.right);
        var top = pin(s.top), bottom = pin(s.bottom);
        var w = pin(s.width), h = pin(s.height);

        if (left === null && right === null) return;
        if (top === null && bottom === null) return;

        if (left === null) left = frame.w - right - (w || 0);
        if (top === null) top = frame.h - bottom - (h || 0);
        if (w === null) w = right === null ? null : frame.w - left - right;
        if (h === null) h = bottom === null ? null : frame.h - top - bottom;
        if (w === null || h === null || w <= 0 || h <= 0) return;

        sink.push({
          kind: 'shape',
          box: { x: frame.x + left, y: frame.y + top, w: w, h: h },
          fill: colour(s.backgroundColor),
          sides: ['Top', 'Right', 'Bottom', 'Left'].map(function (side) {
            return {
              ink: colour(s['border' + side + 'Color']),
              w: parseFloat(s['border' + side + 'Width']) || 0,
              kind: s['border' + side + 'Style']
            };
          }),
          radius: parseFloat(s.borderTopLeftRadius) || 0,
          angle: 0
        });
      });

      if (!angle) {
        textRuns(el, style).forEach(function (o) { sink.push(o); });
        return;
      }

      /* Turned text is measured lying down and then turned, for two reasons.
       * A bounding box around a turned letter is taller than the letter and sits
       * lower than the letter as it advances, so reading line breaks off one turns
       * a stamp into one short word per line. And the anchor a line is drawn from
       * has to lie on the turned baseline for jsPDF's own turn to come out right,
       * which is far easier to guarantee from a flat measurement than to recover
       * from a pile of tilted rectangles. */
      var keep = el.style.transform;
      el.style.transform = 'none';

      var flat = box(el);
      var cx = flat.x + flat.w / 2;
      var cy = flat.y + flat.h / 2;
      var a = angle * Math.PI / 180;
      var cos = Math.cos(a);
      var sin = Math.sin(a);

      function turn(x, y) {
        var dx = x - cx;
        var dy = y - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
      }
      textRuns(el, view.getComputedStyle(el)).forEach(function (o) {
        var start = turn(o.left, o.baseline);
        var end = turn(o.right, o.baseline);

        o.left = start[0];
        o.right = end[0];
        o.baseline = start[1];
        o.angle = angle;
        /* The stamp's own middle, so the drawing can put the letters back on it.
         *
         * The label is placed from its own left edge, and the file's font is not the
         * page's font, so the letters come out narrower than the space the page
         * reserved for them. Left where the page put them they sit against one side
         * of a box built for the wider string - and on the payment stamp, the only
         * boxed label a bill carries, that reads as a stamp that does not fit its own
         * border. The box was what the page centred, so the box is what the letters
         * are centred on, measured in the file's own font at drawing time.
         *
         * It is the box's true middle that is carried over, and not the label's
         * middle height: turning the box's horizontal centre along a baseline gives a
         * point that is only the centre in one direction, and the letters end up
         * shifted along the stamp as well as across it. */
        o.centred = style.textAlign === 'center';
        o.centre = turn(cx, cy)[0];
        o.centreY = turn(cx, cy)[1];
        sink.push(o);
      });

      /* The flat box, kept so a harness can measure what was drawn against the box
       * the letters were put in the middle of. A turned element reports a larger
       * rectangle than itself, so the stamp is put down first and asked again.
       *
       * box() already speaks millimetres - it converts as it reads the element - so
       * these numbers are passed straight on. Converting them a second time here
       * would divide them by the same factor they were multiplied by, and a box
       * that came out at a quarter of its own size would be checked against letters
       * that are not. */
      stampFlat = { x: flat.x, y: flat.y, w: flat.w, h: flat.h,
        cx: flat.x + flat.w / 2, cy: flat.y + flat.h / 2, angle: angle };

      el.style.transform = keep;
    }

    /* The ordinary pass: everything that lies where it sits. Raised elements are
     * left for the second pass, subtree and all. */
    function flowing(el, sink) {
      var style = view.getComputedStyle(el);
      if (!visible(el, style) || raised(style)) return;

      emit(el, style, sink);
      for (var i = 0; i < el.children.length; i++) flowing(el.children[i], sink);
    }

    /* The second pass: only what the browser lifts above the flow, drawn in the
     * order it is stacked. An element that is not itself lifted is still looked
     * through, because a lifted one may be sitting somewhere underneath it. */
    function lifted(el, sink, inside) {
      var style = view.getComputedStyle(el);
      if (!visible(el, style)) return;

      if (!inside && !raised(style)) {
        for (var i = 0; i < el.children.length; i++) lifted(el.children[i], sink, false);
        return;
      }

      emit(el, style, sink);
      for (var j = 0; j < el.children.length; j++) lifted(el.children[j], sink, true);
    }

    // The bill's own paper is part of the flow, so it is laid down first and
    // everything after it lands on top, which is the order the browser paints in.
    flowing(root, ops);
    lifted(root, ops, false);

    return {
      ops: ops,
      height: px(bill.getBoundingClientRect().height),
      width: px(origin.width),
      stamp: stampFlat
    };
  }

  /* ----------------------------------------------------------------- drawing */
  function paint(jsPDF, ops, sheet) {
    var doc = new jsPDF({
      unit: 'mm',
      format: [sheet.w, sheet.h],
      orientation: sheet.portrait ? 'portrait' : 'landscape',
      compress: true
    });

    var doc_ = doc;

    /* A shape, turned about its own centre the way the stylesheet turns it.
     *
     * Rounded corners are walked as a polyline rather than left to jsPDF's
     * roundedRect, for two reasons. The bill's stamp is a pill turned twelve
     * degrees and its four corner marks are quarter circles turned a quarter
     * turn each, so the shape has to survive being rotated - which means the
     * corners have to be points that can be turned with it. And each side carries
     * its own colour, so a corner arc has to belong to a side to be drawn in that
     * side's ink. */
    function outlinePoints(o) {
      var b = o.box;
      var r = Math.min(o.radius, b.w / 2, b.h / 2);

      /* A square corner still has two points on each of its sides, because each
       * side is stroked as its own run and a run of one point draws nothing. This
       * is where the bill's table rules and the half sheet's cut line live: both
       * are square-cornered borders, and a bill drawn without them is missing
       * every line in its table. */
      if (!(r > 0)) {
        return [
          { x: b.x, y: b.y, side: 'Top' },
          { x: b.x + b.w, y: b.y, side: 'Top' },
          { x: b.x + b.w, y: b.y, side: 'Right' },
          { x: b.x + b.w, y: b.y + b.h, side: 'Right' },
          { x: b.x + b.w, y: b.y + b.h, side: 'Bottom' },
          { x: b.x, y: b.y + b.h, side: 'Bottom' },
          { x: b.x, y: b.y + b.h, side: 'Left' },
          { x: b.x, y: b.y, side: 'Left' }
        ];
      }

      var pts = [];
      function at(x, y, side) { pts.push({ x: x, y: y, side: side }); }

      // Each side gets one unbroken run: its own straight edge, then the corner
      // that ends it. The next side starts by naming that same corner again, so
      // the two runs meet where the browser would have them meet and no part of
      // the outline falls between them.
      function arc(cx, cy, from, to, side) {
        var steps = Math.max(3, Math.ceil(Math.abs(to - from) / 15));
        for (var i = 0; i <= steps; i++) {
          var a = (from + (to - from) * i / steps) * Math.PI / 180;
          at(cx + r * Math.cos(a), cy + r * Math.sin(a), side);
        }
      }

      at(b.x + r, b.y, 'Top');
      at(b.x + b.w - r, b.y, 'Top');
      arc(b.x + b.w - r, b.y + r, -90, 0, 'Top');

      at(b.x + b.w, b.y + r, 'Right');
      at(b.x + b.w, b.y + b.h - r, 'Right');
      arc(b.x + b.w - r, b.y + b.h - r, 0, 90, 'Right');

      at(b.x + b.w - r, b.y + b.h, 'Bottom');
      at(b.x + r, b.y + b.h, 'Bottom');
      arc(b.x + r, b.y + b.h - r, 90, 180, 'Bottom');

      at(b.x, b.y + b.h - r, 'Left');
      at(b.x, b.y + r, 'Left');
      arc(b.x + r, b.y + r, 180, 270, 'Left');

      return pts;
    }

    function shape(o) {
      var b = o.box;
      var cx = b.x + b.w / 2;
      var cy = b.y + b.h / 2;
      var a = o.angle * Math.PI / 180;

      /* The side a point belongs to travels with it through the turn. It is what
       * says which ink a stretch of the outline is drawn in, and a point that
       * loses its label on the way round leaves every border in the bill with
       * nothing to stroke. */
      function turn(p) {
        if (!o.angle) return { x: p.x, y: p.y, side: p.side };
        var dx = p.x - cx;
        var dy = p.y - cy;
        return {
          x: cx + dx * Math.cos(a) - dy * Math.sin(a),
          y: cy + dx * Math.sin(a) + dy * Math.cos(a),
          side: p.side
        };
      }

      var pts = outlinePoints(o).map(function (p) { return turn(p); });

      function trace(closed) {
        var moves = [];
        for (var i = 1; i < pts.length; i++) {
          moves.push([pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y]);
        }
        if (closed) {
          moves.push([pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y]);
        }
        return moves;
      }

      if (o.fill) {
        doc_.setFillColor.apply(doc_, o.fill);
        if (!o.angle && !o.radius) doc_.rect(b.x, b.y, b.w, b.h, 'F');
        else doc_.lines(trace(true), pts[0].x, pts[0].y, [1, 1], 'F', true);
      }

      // Borders are stroked side by side. Each run is a separate call, so where
      // two sides of different colours meet the join is drawn over rather than
      // one rule winning outright.
      var order = ['Top', 'Right', 'Bottom', 'Left'];
      order.forEach(function (name, i) {
        if (!o.sides) return;
        var side = o.sides[i];
        if (!side || !side.ink || !side.w) return;

        var run = [];

        pts.forEach(function (p, k) {
          if (p.side === name) run.push(p);
        });
        if (run.length < 2) return;

        doc_.setDrawColor.apply(doc_, side.ink);
        doc_.setLineWidth(px(side.w));
        doc_.setLineDashPattern(dashFor(side), 0);

        var moves = [];
        for (var k = 1; k < run.length; k++) {
          moves.push([run[k].x - run[k - 1].x, run[k].y - run[k - 1].y]);
        }

        doc_.lines(moves, run[0].x, run[0].y, [1, 1], 'S', false);
      });

      doc_.setLineDashPattern([], 0);
    }

    /* A closed run of steps for jsPDF, which draws nothing for a single step. */
    function closed(points) {
      var moves = [];
      for (var i = 1; i < points.length; i++) {
        moves.push([points[i].x - points[i - 1].x, points[i].y - points[i - 1].y]);
      }
      return moves;
    }

    /* The rupee sign.
     *
     * U+20B9 is in none of the fonts a PDF can carry, so it cannot be set as a
     * letter - a bill sent from a phone cannot embed a font file. It has been
     * drawn here as a path instead, twice, and both drawings were wrong in ways
     * that only showed once they were on paper: a hand-cut sign is a guess at a
     * glyph, and a guess at the currency sign beside an exact figure is worse
     * than no sign at all.
     *
     * So it is not drawn. The browser already has the right one - it is set on
     * the printed bill in the very same font, from the very same stack - so the
     * same character is set into a small transparent picture and that picture is
     * what goes in the file. The sign in the PDF is then the sign on the print,
     * rather than something resembling it.
     *
     * The picture is made once per size, weight and colour and used for every
     * sign on the bill, so on a full A4 it costs about a kilobyte rather than
     * most of the file. It is drawn several times larger than it is placed, which
     * is what keeps it sharp on paper: at the size it is set at, a picture would
     * be drawn once per printer dot and looked soft next to the vector rules
     * beside it. */
    var RUPEE = '\u20b9';
    var glyphs = {};

    function rupeeWidth(size) {
      return size * 0.58 * PT;
    }

    function rupeePaint(o) {
      var ink = o.ink || [0, 0, 0];
      var key = o.size.toFixed(2) + '/' + (o.bold ? 'b' : 'n') + '/' + o.font + '/' + ink.join(',');
      if (glyphs[key]) return glyphs[key];

      var sizePx = (o.size * PT) / MM;   // the points back to the pixels the print sets it in
      var over = 6;                       // drawn large, placed small

      /* The sign is drawn at the large size and measured there, because a picture
       * of a 60px glyph is a picture of that glyph: setting the font to the small
       * size and putting it in a large canvas draws the sign tiny in the corner of
       * its own picture, and the file then carries the mark at a fraction of the
       * size it is set at. Every measurement below is in the large pixels and is
       * brought back to the printed size on the way out. */
      var big = sizePx * over;
      var face = (o.bold ? 'bold ' : '') + big + 'px ' + (o.stack || o.font);

      // Measured on a scratch context first, because the size of the picture is
      // decided by the glyph and the glyph has to be measured before the picture
      // exists. A canvas resized after its context is set throws that setting
      // away, so the real context is given the font again below.
      var scratch = document.createElement('canvas').getContext('2d');
      scratch.font = face;
      var m = scratch.measureText(RUPEE);

      var asc = m.fontBoundingBoxAscent || big * 0.8;
      var desc = m.fontBoundingBoxDescent || big * 0.2;
      var wide = m.width || big * 0.6;

      /* A font without the sign measures it as a missing glyph, and a missing
       * glyph drawn small is a little empty box - which on a bill is worse than
       * the shape that was there before, so the caller is told and falls back. */
      if (!m.width || m.width <= 0) return null;

      var pad = 2;
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(wide) + pad * 2);
      c.height = Math.max(1, Math.ceil(asc + desc) + pad * 2);

      var ctx = c.getContext('2d');
      ctx.font = face;
      ctx.fillStyle = 'rgb(' + ink.join(',') + ')';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(RUPEE, pad, pad + asc);

      /* The picture is trimmed to the ink. A font's ascent is taller than the sign
       * standing on it and its descent hangs below the baseline, so a picture that
       * keeps the whole line carries a band of empty paper above and below the
       * character: the sign is then set higher on the bill than the figures beside
       * it, and the file carries more pixels than the mark needs. Which rows were
       * actually drawn is read back off the picture, so the trim is the glyph's own
       * outline rather than a guess at one. */
      var bits = ctx.getImageData(0, 0, c.width, c.height).data;
      var top = -1;
      var bottom = -1;

      for (var row = 0; row < c.height && top < 0; row++) {
        for (var col = 0; col < c.width; col++) {
          if (bits[(row * c.width + col) * 4 + 3] > 0) { top = row; break; }
        }
      }
      for (var back = c.height - 1; back > top && bottom < 0; back--) {
        for (var side = 0; side < c.width; side++) {
          if (bits[(back * c.width + side) * 4 + 3] > 0) { bottom = back; break; }
        }
      }

      /* Nothing was drawn at all, which is the sign missing from the font. The
       * caller is told, and answers for it with the shape it used to be. */
      if (top < 0 || bottom < top) return null;

      var trim = document.createElement('canvas');
      trim.width = c.width;
      trim.height = bottom - top + 1;
      trim.getContext('2d').drawImage(c, 0, top, c.width, trim.height,
        0, 0, c.width, trim.height);

      glyphs[key] = {
        url: trim.toDataURL('image/png'),
        /* The picture is the sign itself, from the top of what it draws down to
         * where it stands, and is set on the baseline the figures share - so it
         * neither floats above them nor hangs below them. Every figure here is a
         * large pixel and is brought back to the printed size, which is what the
         * picture is measured in once it is placed. */
        w: px(wide / over),
        h: px((bottom - top + 1) / over),
        rise: px((asc - (top - pad)) / over)
      };

      return glyphs[key];
    }

    function rupee(x, o) {
      var g = rupeePaint(o);
      if (g) {
        signsDrawn++;
        doc_.addImage(g.url, 'PNG', x, o.baseline - g.rise, g.w, g.h);
        return;
      }

      /* No font on this machine carries the sign. The proportions of a sans-serif
       * capital are drawn instead - two bars, and below them a stem that stops
       * short and kicks out to the right, which is the part that keeps it from
       * reading as a letter. Thousandths of the em, so it holds its shape at
       * whatever size it is set beside. */
      var SIGN = [
        [[40, 1000], [790, 1000]],
        [[70, 730], [830, 730]],
        [[250, 730], [250, 320], [890, 0]]
      ];
      var cap = o.size * 0.72 * PT;
      var wide = o.rupee || rupeeWidth(o.size);

      function at(p) {
        return { x: x + p[0] / 1000 * wide, y: o.baseline + p[1] / 1000 * cap };
      }

      doc_.setDrawColor.apply(doc_, o.ink);
      doc_.setLineWidth(Math.max(0.11, o.size * 0.07 * PT));
      doc_.setLineDashPattern([], 0);

      SIGN.forEach(function (run) {
        var moves = [];
        var first = at(run[0]);

        for (var i = 1; i < run.length; i++) {
          var a = at(run[i - 1]);
          var b = at(run[i]);
          moves.push([b.x - a.x, b.y - a.y]);
        }

        doc_.lines(moves, first.x, first.y, [1, 1], 'S', false);
      });

      signsDrawn++;
    }

    /* A dashed rule is drawn the way the browser draws it: a run of three line
     * widths, a gap of three. Reading the style rather than assuming solid is
     * what keeps the half sheet's cut line looking like a cut line. */
    function dashFor(side) {
      if (side.kind === 'dashed' || side.kind === 'double') return [3, 3];
      if (side.kind === 'dotted') return [0.01, 3];
      return [];
    }

    var images = [];

    ops.forEach(function (o) {
      if (o.kind === 'fill') {
        doc_.setFillColor.apply(doc_, o.ink);
        doc_.rect(o.x, o.y, o.w, o.h, 'F');
        return;
      }

      if (o.kind === 'shape') { shape(o); return; }

      /* An outline of its own - a circle in an inline picture, where there is no
       * box and no corner radius to read but the shape itself. Drawn as a closed
       * run of straight steps, which at the size these appear is indistinguishable
       * from a curve. */
      if (o.kind === 'path') {
        if (!o.points || o.points.length < 2) return;

        if (o.fill) {
          doc_.setFillColor.apply(doc_, o.fill);
          doc_.lines(closed(o.points), o.points[0].x, o.points[0].y, [1, 1], 'F', true);
        }

        if (o.ink && o.w) {
          doc_.setDrawColor.apply(doc_, o.ink);
          doc_.setLineWidth(o.w);
          doc_.setLineDashPattern([], 0);
          doc_.lines(closed(o.points), o.points[0].x, o.points[0].y, [1, 1], 'S', true);
        }
        return;
      }

      if (o.kind === 'image') { images.push(o); return; }

      var text = o.text;
      if (!text || !o.ink) return;

      doc_.setFont(o.font, o.bold ? 'bold' : 'normal');
      doc_.setFontSize(o.size);
      doc_.setTextColor.apply(doc_, o.ink);
      if (o.gap) doc_.setCharSpace(o.gap);

      /* The rupee sign is written in the bill and is not in the fonts jsPDF
       * carries, which were standardised before it existed. Set as text it comes
       * out of the file as a row of nothing, which on a bill means every amount
       * is missing its currency. It is drawn instead - two bars over a stem and a
       * leg, which is the whole of the sign - and the line is set either side of
       * it, so nothing else on the line moves. */
      var parts = String(text).split(/(₹)/).filter(function (s) { return s !== ''; });
      var rupees = parts.length > 1;

      function widthOf(part) {
        if (part !== '₹') return doc_.getTextWidth(part) + o.gap * part.length;
        return o.rupee || rupeeWidth(o.size);
      }

      // jsPDF measures its own fonts, which are not the browser's, so the width
      // it reports is the one the line has to be placed by. What the browser
      // measured is the edge: left, centre or right. Aligning to the edge is what
      // keeps a column of figures looking like a column.
      var wide = parts.reduce(function (a, s) { return a + widthOf(s); }, 0);

      /* The width of the marks on the page, as against the width a run is advanced
       * by. They differ by one letter-space and the difference is not nothing to
       * do with.
       *
       * Each piece is moved on by its glyphs plus a letter-space, because that space
       * is what holds two pieces apart. The space after the last piece has nothing
       * after it to be spaced from: it is written past the final letter, off the
       * end of the run, and no reader ever sees it. Counting it makes a run one
       * letter-space too wide, and a label centred on that total sits half a
       * letter-space off its middle - which is small, but it is on the one thing
       * on a bill that has to look deliberate. */
      var ink = parts.reduce(function (a, s) {
        return a + (s === '₹' ? (o.rupee || rupeeWidth(o.size)) : doc_.getTextWidth(s));
      }, 0) + o.gap * Math.max(0, wideChars(parts) - 1);

      function wideChars(ps) {
        return ps.reduce(function (a, s) { return a + (s === '₹' ? 1 : s.length); }, 0);
      }

      var x = o.left;
      /* A boxed label is centred on its box, not on its own span.
       *
       * The page centred the stamp's text in the stamp's box, so o.left and
       * o.right are the edges of the *text*, not of the box. Centring between them
       * would place the file's narrower letters at the text's own centre, which is
       * where they already were - and since the file sets Helvetica-Bold where the
       * page set Segoe UI, the two widths differ, so a run placed from the text's
       * left edge ends up pressed to one side of a box built for the wider string.
       * That is the payment stamp, and on a bill it is the only boxed label there
       * is, so it reads as a stamp that does not fit its own border. The box's
       * centre is carried over from the measurement for exactly this. */
      if (o.centred && o.centre != null) x = o.centre - ink / 2;
      else if (o.align === 'right') x = o.right - wide;
      else if (o.align === 'center') x = o.left + (o.right - o.left) / 2 - wide / 2;

      var at = { baseline: 'alphabetic' };
      /* A turn the other way, and the page's up is the file's down.
       *
       * The page measures with y growing downwards and the file is written with y
       * growing upwards, so the same tilt has opposite signs in the two. A stamp
       * turned anticlockwise on the page is turned clockwise in the file.
       *
       * Handing jsPDF the page's own angle turns the text the wrong way, and the
       * border the right way, because the border is not handed over at all - it is
       * turned here, by turn(), where the flip is accounted for. The two then lie
       * either side of the horizontal instead of on top of each other: the label
       * runs down across its own stamp as the border runs up, and because the
       * stamp is wider than it is tall, the far end of the label clears the border
       * altogether and hangs outside it. Sixteen degrees across a twenty
       * millimetre stamp is more than a millimetre of overhang - not a stamp
       * slightly out of true, but text crossing out of its own border. */
      if (o.angle) at.angle = -o.angle;

      parts.forEach(function (part) {
        if (part === '₹') {
          rupee(x, o);
          x += widthOf(part);
          return;
        }

        if (o.link && doc_.textWithLink) {
          at.url = o.link;
          doc_.textWithLink(part, x, o.baseline, at);
        } else {
          doc_.text(part, x, o.baseline, at);
        }
        x += widthOf(part);
      });

      if (o.underline) {
        doc_.setDrawColor.apply(doc_, o.ink);
        doc_.setLineWidth(o.size * 0.06);
        doc_.line(o.left, o.baseline + o.size * 0.12, o.left + wide, o.baseline + o.size * 0.12);
      }

      if (o.gap) doc_.setCharSpace(0);
      if (rupees) doc_.setLineDashPattern([], 0);
    });

    // Pictures last, so nothing draws over the logo.
    return Promise.all(images.map(function (o) {
      return bitmap(o).then(function (data) {
        if (!data) return null;
        var b = o.box;
        var scale = Math.min(b.w / data.width, b.h / data.height);
        var w = data.width * scale;
        var h = data.height * scale;
        try {
          doc_.addImage(data.url, 'PNG', b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
        } catch (e) {
          return null;
        }
        return null;
      });
    })).then(function () {
      cutLine(doc_, sheet);
      return doc_;
    });
  }

  /* The cut line on a half sheet, drawn at the middle of the paper.
   *
   * A half sheet is bought for one thing: the sheet is cut down the middle and the
   * blank half is reused for the next bill. That only works if the line really is
   * the middle of the paper, and it cannot be drawn as part of the bill, because
   * the bill is scaled to fit its sheet - shrink it even slightly and a cut line
   * drawn inside it moves off the middle, so cutting on it gives one usable half
   * and one that is a millimetre short.
   *
   * So the line is drawn on the paper, not on the bill: the same place whatever the
   * fit decided, from the top margin to the bottom margin. It is also why the
   * stylesheet gives the frame a plain right border on a half sheet - two vertical
   * lines a millimetre apart print as one smudge.
   */
  function cutLine(doc_, sheet) {
    if (sheet.portrait) return;
    try {
      var gap = 5;
      doc_.saveGraphicsState();
      doc_.setDrawColor(15, 34, 57);
      doc_.setLineWidth(0.5);
      doc_.setLineDashPattern([3, 2], 0);
      doc_.line(sheet.w / 2, gap, sheet.w / 2, sheet.h - gap);
      doc_.restoreGraphicsState();
    } catch (e) {
      // A sheet with no cut line is still a bill; only the reuse is lost.
    }
  }

  /* A logo, read once and kept small. A shop logo is a photograph of a shop sign, so
   * it is worth a few kilobytes at a size that stays sharp on paper.
   *
   * The picture the document has already decoded is used, not the address it came
   * from. Asking for the address again means asking the network for a file the
   * browser is already holding, and it fails in a way that is invisible on a
   * server and very visible anywhere the page was opened from disk: a fetch of a
   * local file is refused, the logo is quietly left out, and the bill comes out as
   * a sheet of text with an empty gold frame where the shop mark should be. Reading
   * the element that is already on the page cannot fail that way, and saves
   * downloading a megabyte of logo a second time. */
  function bitmap(pic) {
    var el = pic && pic.el;

if (el && el.complete && el.naturalWidth) return Promise.resolve(square(el));

    /* The element is asked first because by this point it has usually decoded, and
     * the file is asked for only when it has not. */
    if (!pic.src) return Promise.resolve(null);

    return Promise.resolve().then(function () {
      return fetch(pic.src).then(function (res) {
        if (!res.ok) throw new Error('no image');
        return res.blob();
      }).then(function (blob) {
        return new Promise(function (resolve) {
          var img = new Image();
          img.onload = function () { resolve(square(img)); };
          img.onerror = function () { resolve(null); };
          img.src = URL.createObjectURL(blob);
        });
      }).catch(function () { return null; });
    });
  }

  /* Letterboxes a picture into a square of white and hands back the PNG bytes.
   * White behind it because a shop logo is very often a photograph of a sign with
   * daylight in one corner, and a transparent logo printed on a bill shows the
   * bill's own cream through it. */
  function square(img) {
    try {
      var side = 420;
      var c = document.createElement('canvas');
      c.width = side;
      c.height = side;

      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, side, side);

      var k = Math.min(side / img.naturalWidth, side / img.naturalHeight);
      var w = img.naturalWidth * k;
      var h = img.naturalHeight * k;
      ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);

      return { url: c.toDataURL('image/png'), width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------------- one page
   * The printed document's own fit, called rather than copied. It lives in bills.js
   * beside the markup and it is the thing that decides how tall a document is
   * allowed to be, so a file that fitted it a different way would be a second
   * opinion about the same question. Being handed the same function is the point.
   *
   * The root is the element that is measured, which is the bill for a bill and the
   * receipt for a receipt. Both are shrunk by the same arithmetic rather than each
   * getting its own idea of what fits on a sheet.
   */
  function fit(doc, size, root) {
    var page = doc.querySelector(root || '.bill');
    if (!page) return 1;

    // Whatever the fit settled on is what gets drawn. A document that already
    // fitted is left at its own size and simply ends above the bottom of the sheet,
    // and one that was too tall arrives shrunk, exactly as it would come off the
    // printer. Nothing is scaled a second time on the way into the file.
    return window.ANT.bills.__fitToOnePage(
      doc.defaultView,
      window.ANT.printsize.pageHeightMm(size),
      window.ANT.printsize.billWidthMm(size),
      root
    );
  }

  /* Which document is being drawn.
   *
   * A bill is the default because a bill is what nearly every call is. A receipt
   * passes its own module in and gets the same treatment from the same code: the
   * same stylesheet, the same fit, the same drawing and the same handover to the
   * printer. A receipt with its own print path is how a receipt ends up looking
   * like a bill on one day and not on the next.
   */
  function sourceOf(source) {
    if (source && typeof source.markup === 'function') return source;
    return window.ANT.bills;
  }

  function whatOf(owner) {
    return owner.what || 'bill';
  }

  function render(snap, source) {
    signsDrawn = 0;
    stampFlat = null;
    var owner = sourceOf(source);
    var what = whatOf(owner);

    return library().then(function (jsPDF) {
      var sheet = sheetFor(snap.printSize);
      var html = owner.markup(snap);

      return stage(html, sheet.w).then(function (staged) {
        if (!staged) throw new Error('the ' + what + ' could not be laid out');

        var doc = staged.doc;
        var ops;

        try {
          fit(doc, snap.printSize, owner.root);

          var drawn = outline(doc, halfRoom(sheet));
          if (!drawn) throw new Error('the ' + what + ' could not be measured');
          ops = drawn.ops;

          return paint(jsPDF, ops, sheet);
        } finally {
          // Taken down only once everything has been read out of it, and whether
          // or not the drawing worked - a document that failed to measure must not
          // leave a hidden page sitting on the tailor's screen.
          staged.release();
        }
      });
    }).then(function (doc) {
      return doc.output('blob');
    });
  }

  /* ------------------------------------------------------- handing it over
   * Drawing a file and printing it are one job, and they are the same job for a
   * bill and for a receipt. There is one way to the printer now.
   *
   * The printer is handed the file, not the page. A page names its paper in an
   * @page rule, but Chrome reads that rule for the layout and not for the paper:
   * the dialog opens on the printer's last sheet with an A5 page laid out on it,
   * and the bill comes out shrunk into the corner of the wrong paper. The file
   * carries the same size where the printer does read it, so it is the file that
   * goes to a tab - and a tab is a top-level document, which is the one place the
   * browser takes the paper from. The tailor presses print in that tab; the paper
   * is already right when they do.
   */
  var printing = null;

  /* Let go of the file the last print opened.
   *
   * The URL is the document itself, and while a tab is holding it open it has to
   * stay live - a revoked URL shows the tailor a browser error instead of the bill.
   * The next print lets go of the last one, so a counter printing all afternoon is
   * not holding every bill it has ever printed. */
  function releasePrinted() {
    if (!printing) return;
    if (printing.url) URL.revokeObjectURL(printing.url);
    printing = null;
  }

  /* Open the finished file in a tab, which is a top-level document and so the one
   * place the browser takes the paper out of it. The dialog is not raised here:
   * the viewer's own print button brings it up already holding the right paper,
   * which is the whole reason for the tab. */
  function printBlob(blob, name) {
    var url = URL.createObjectURL(blob);

    // Whatever the previous print opened is let go of before this one is
    // registered, so a counter printing all afternoon is not holding every bill
    // it has ever printed.
    releasePrinted();
    printing = { url: url };

    var tab = window.open(url, '_blank');
    if (!tab) {
      // Nothing took the document, so nobody else is holding it either. Withdrawing
      // it now is what stops the browser keeping every blocked bill alive for the
      // rest of the session.
      releasePrinted();
      toast('Your browser blocked the new tab. Allow pop-ups to print.', 'error');
      return null;
    }

    toast((name ? name : 'The bill') + ' opened in a new tab. Press its print ' +
      'button to print it on the right paper size.', 'warning');
    return tab;
  }

  /* Put the document in front of the printer as a web page, standing in for the
   * file.
   *
   * Drawing the file is the way to the printer, because a tab holding it is a
   * top-level document and the browser takes the paper from the file's own page
   * size. This is the fallback for when the file cannot be drawn at all: the page
   * the bill was laid out on is still a bill, and its @page rule still names the
   * right paper - a browser that reads that rule, as Chrome does for the layout if
   * not always for the dialog, is no worse off than the file would have left it. A
   * bill on the wrong paper beats no bill.
   *
   * It is the same document either way - the same markup out of the same module,
   * with the same stylesheet and the same @page rule the PDF was measured against -
   * so this is the bill drawn by the page rather than a drawing of the bill.
   *
   * The PDF is not given up. Sharing, saving and the WhatsApp slip still go through
   * render(), because a file is what a phone can open and what a shop can keep. */
  function printHtml(snap, source, name) {
    var owner = sourceOf(source);
    var what = whatOf(owner);
    var sheet = sheetFor(snap && snap.printSize);
    var html = owner.markup(snap);

    return stage(html, sheet.w).then(function (staged) {
      if (!staged) throw new Error('the ' + what + ' could not be laid out for printing');

      var view = staged.doc.defaultView;
      if (!view || !view.print) {
        staged.release();
        throw new Error('this browser will not print a page from a frame');
      }

      /* The frame is left standing while the dialog is up, because a document
       * taken out from under its own print call prints a blank page. It is taken
       * down once the dialog closes - the print dialog is modal, so the next line
       * runs when the tailor has finished with it. */
      try {
        view.focus();
        view.print();
      } catch (e) {
        staged.release();
        throw e;
      }

      var clear = function () {
        staged.release();
        window.removeEventListener('afterprint', clear);
        document.removeEventListener('afterprint', clear);
      };
      window.addEventListener('afterprint', clear);
      document.addEventListener('afterprint', clear);
      /* Not every browser fires afterprint, and a frame left off the page is
       * invisible and harmless but is not something to leave behind all day. */
      setTimeout(clear, 60000);

      return staged;
    });
  }

  /* Draw the document and put it in front of the printer, which is the whole of
   * what "print this" means. Every caller goes through here. */
  function print(snap, source, name) {
    var owner = sourceOf(source);
    var what = whatOf(owner);

    /* The file is the printer's copy, because it is the one the browser takes the
     * paper size from. Only if the file cannot be drawn does the page stand in, so
     * a browser that will not draw the bill still gets its bill. */
    return render(snap, owner).then(function (blob) {
      return printBlob(blob, name || what);
    }).catch(function () {
      return printHtml(snap, owner, name);
    });
  }

  /* Measure a document without drawing it, and hand back what the stamp's flat box
   * came out as.
   *
   * The stamp's box is the one measurement on a bill that cannot be taken from the
   * page afterwards: a turned element reports a rectangle larger than itself, so a
   * second look at it is a second opinion off the wrong box. The walk is where the
   * stamp is put down and asked for its own size, and that answer is kept. The
   * hidden page is taken down again before anything is returned, because a harness
   * that asked would otherwise leave a document sitting on the tailor's screen. */
  function outlineStage(snap, source) {
    var owner = sourceOf(source);
    var what = whatOf(owner);
    var sheet = sheetFor(snap && snap.printSize);
    var html = owner.markup(snap);

    return stage(html, sheet.w).then(function (staged) {
      if (!staged) throw new Error('the ' + what + ' could not be laid out');

      var drawn;
      try {
        fit(staged.doc, snap.printSize, owner.root);
        drawn = outline(staged.doc, halfRoom(sheetFor(snap && snap.printSize)));
        if (!drawn) throw new Error('the ' + what + ' could not be measured');
        return {
          ops: drawn.ops, height: drawn.height, width: drawn.width, stamp: stampFlat
        };
      } finally {
        staged.release();
      }
    });
  }

  return {
    render: render,
    print: print,
    library: library,
    /* Exposed for the harness, which measures the same printed document and
     * compares it with what came out of the PDF. */
    __outline: outline,
    __outlineStage: outlineStage,
    __stage: stage,
    __sheet: sheetFor,
    __printBlob: printBlob,
    __printHtml: printHtml,
    __releasePrinted: releasePrinted,
    __signs: function () { return signsDrawn; },
    /* The stamp's flat box, as of the last document measured. Exposed for the same
     * reason __signs is: the stamp is the one thing on a bill whose box and whose
     * lettering have to be checked against each other in the finished file, and the
     * box is only knowable from inside the walk. */
    __stamp: function () { return stampFlat; }
  };
})();

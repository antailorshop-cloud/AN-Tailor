/* AN TAILOR - the shared bill PDF.
 *
 * This draws the bill that gets stored and put in the WhatsApp message. It is
 * drawn rather than photographed for one reason: size. Rendering the page
 * through a canvas produces a bitmap of the whole sheet, which lands at about
 * 200KB a bill and fills a free 1GB bucket in a year and a half. Drawing the
 * same page with text and lines is about 15KB, and the QR stays sharp at any
 * zoom instead of being resampled.
 *
 * The one thing a drawn bill cannot have is the rupee sign. jsPDF's built-in
 * fonts are Latin-1 and have no glyph for it, and embedding a font that does
 * would add its whole file to every bill - which is the size this file exists to
 * avoid. So money is written "Rs." here, as an Indian invoice traditionally
 * does, while the on-screen and printed bill keep the symbol.
 *
 * The bill is built from a snapshot rather than from live orders, so the stored
 * PDF is the bill that was raised and not a later reading of it. That also means
 * a PDF cleared out of storage can be rebuilt from bills.pdf_snapshot later.
 */

window.ANT = window.ANT || {};

window.ANT.billpdf = (function () {
  var LIB = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  var GOLD = [184, 147, 79];
  var GOLD_SOFT = [205, 184, 148];
  var NAVY = [34, 49, 79];
  var INK = [40, 40, 40];
  var MUTED = [122, 112, 92];

  var SHEETS = { A4: [210, 297], A5: [148, 210], LETTER: [216, 279] };

  var loading = null;

  /* The drawing library is fetched on first use and kept. Loading it with the
   * page would put a third-party script in the boot path of a shop phone on a
   * weak connection, which is the one thing the rest of this app avoids. */
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

  /* Money, with the symbol the built-in fonts cannot draw. */
  function money(value) {
    var out = window.ANT.money ? String(window.ANT.money(value)) : String(value || 0);
    return out.replace(/\u20b9/g, 'Rs. ');
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function dateLabel(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function setFont(doc, style, size, colour) {
    doc.setFont('helvetica', style || 'normal');
    doc.setFontSize(size || 9);
    doc.setTextColor.apply(doc, colour || INK);
  }

  function setInk(doc, colour) { doc.setTextColor.apply(doc, colour); }

  /* The gold frame and corner flourishes. Drawn on every page, because a
   * continuation page with no frame looks like a different document. */
  function frame(doc, w, h) {
    doc.setDrawColor.apply(doc, GOLD);
    doc.setLineWidth(0.7);
    doc.rect(6, 6, w - 12, h - 12);
    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.rect(7.6, 7.6, w - 15.2, h - 15.2);

    doc.setLineWidth(0.45);
    // A ring and a dot tucked inside each corner. A true quarter-arc flourish
    // would need a path API this library does not have, and a cut-off circle
    // painted over the frame would take the frame line with it, so the corner is
    // marked with a shape that can be drawn cleanly.
    var inset = 10.5;
    [[inset, inset], [w - inset, inset], [w - inset, h - inset], [inset, h - inset]].forEach(function (c) {
      doc.circle(c[0], c[1], 2.2, 'S');
      doc.setFillColor.apply(doc, GOLD);
      doc.circle(c[0], c[1], 0.7, 'F');
      doc.setDrawColor.apply(doc, GOLD);
    });
  }

  function hairline(doc, x1, y, x2, colour, width) {
    doc.setDrawColor.apply(doc, colour || GOLD_SOFT);
    doc.setLineWidth(width || 0.2);
    doc.line(x1, y, x2, y);
  }

  /* A section heading: a small gold square, then spaced capitals. */
  function sectionTitle(doc, text, x, y, limit) {
    doc.setFillColor.apply(doc, GOLD);
    doc.rect(x, y - 2.4, 1.5, 1.5, 'F');
    setFont(doc, 'bold', 7.5, GOLD);
    doc.text(String(text).toUpperCase().split('').join(' '), x + 3.2, y);
    return y + 3.4;
  }

  function ornament(doc, cx, y, half) {
    hairline(doc, cx - half, y, cx - 4, GOLD_SOFT, 0.3);
    hairline(doc, cx + 4, y, cx + half, GOLD_SOFT, 0.3);
    doc.setDrawColor.apply(doc, GOLD);
    doc.setLineWidth(0.35);
    doc.circle(cx, y, 2, 'S');
  }

  /* The QR, drawn module by module. Consecutive dark modules on a row are
   * merged into one rectangle, which turns a few hundred drawing operations
   * into about a hundred and keeps the file small. */
  function qr(doc, text, x, y, side) {
    if (!window.ANT.qr || !text) return 0;

    var m;
    try {
      m = window.ANT.qr.matrix(text, window.ANT.qr.ecc.medium);
    } catch (e) {
      return 0;
    }
    if (!m || !m.modules) return 0;

    var quiet = 2;
    var cell = side / (m.size + quiet * 2);

    doc.setFillColor(255, 255, 255);
    doc.rect(x, y, side, side, 'F');
    doc.setFillColor(0, 0, 0);

    for (var r = 0; r < m.size; r++) {
      var c = 0;
      while (c < m.size) {
        if (m.modules[r][c]) {
          var run = 1;
          while (c + run < m.size && m.modules[r][c + run]) run++;
          doc.rect(x + (quiet + c) * cell, y + (quiet + r) * cell, run * cell, cell, 'F');
          c += run;
        } else {
          c++;
        }
      }
    }
    return side;
  }

  /* The shop logo, small enough that a bitmap of it costs a couple of KB. A
   * logo that will not load is not a reason to fail a bill, so this resolves to
   * '' and the masthead simply closes up. */
  function logoData(url) {
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('no logo');
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve) {
          var img = new Image();
          img.onload = function () {
            try {
              var px = 160;
              var c = document.createElement('canvas');
              c.width = px;
              c.height = px;
              var ctx = c.getContext('2d');
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, px, px);
              var side = Math.min(img.width, img.height);
              ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, px, px);
              resolve(c.toDataURL('image/jpeg', 0.8));
            } catch (e) {
              resolve('');
            }
          };
          img.onerror = function () { resolve(''); };
          img.src = URL.createObjectURL(blob);
        });
      })
      .catch(function () { return ''; });
  }

  /* Masthead, drawn once at the top of the first page. */
  function masthead(doc, snap, x, right, y) {
    var shop = snap.shop || {};
    var name = shop.name || 'AN TAILOR';
    var cx = (x + right) / 2;

    if (snap.logoData) {
      try {
        doc.addImage(snap.logoData, 'JPEG', x, y + 1, 19, 19);
      } catch (e) {
        /* the letterhead still reads without the mark */
      }
    }

    setFont(doc, 'bold', 17, NAVY);
    doc.text(String(name).toUpperCase(), cx, y + 6, { align: 'center' });

    setFont(doc, 'normal', 7.5, GOLD);
    doc.text('PROFESSIONAL TAILORING SERVICES', cx, y + 10.5, { align: 'center' });

    var contact = [shop.address, shop.phone, shop.email].filter(Boolean).join('   ·   ');
    if (contact) {
      setFont(doc, 'normal', 7, MUTED);
      doc.text(contact, cx, y + 14, { align: 'center', maxWidth: right - x - 34 });
    }

    var boxBottom = y + 20;
    hairline(doc, x, boxBottom, right, GOLD_SOFT, 0.3);
    ornament(doc, cx, boxBottom + 4, Math.min(34, (right - x) / 2 - 6));
    return boxBottom + 9;
  }

  /* Bill No / Date / Delivery / Status, as four columns between two rules. */
  function billBar(doc, snap, x, right, y) {
    var bill = snap.bill || {};
    var due = Number(snap.bill.balance || 0);
    var advance = Number(snap.bill.advance || 0);
    var status = due <= 0 ? 'Paid' : (advance > 0 ? 'Part Paid' : 'Payment Due');
    var delivery = snap.orders && snap.orders.length ? snap.orders[0].delivery_date : '';

    var cells = [
      ['Bill No', bill.code || '-'],
      ['Bill Date', dateLabel(bill.bill_date)],
      ['Delivery', dateLabel(delivery)],
      ['Status', status]
    ];

    var width = (right - x) / cells.length;
    hairline(doc, x, y, right, GOLD_SOFT, 0.3);

    cells.forEach(function (cell, i) {
      var cx = x + width * i + width / 2;
      setFont(doc, 'normal', 6.5, GOLD);
      doc.text(cell[0].toUpperCase(), cx, y + 3.4, { align: 'center' });
      setFont(doc, 'bold', 9.5, NAVY);
      doc.text(String(cell[1]), cx, y + 7.8, { align: 'center', maxWidth: width - 2 });
    });

    hairline(doc, x, y + 10, right, GOLD_SOFT, 0.3);
    return y + 14;
  }

  /* Customer details beside the address, each in its own ruled box. Both boxes are
   * drawn to the same height, measured from whichever has more to say, so the
   * two boxes always end level with each other and a long address stays inside
   * its own border instead of running out through the bottom of it. */
  function parties(doc, snap, x, right, y) {
    var c = snap.customer || {};
    var wide = (right - x) * 0.56;
    var narrow = right - x - wide - 2;
    var pad = 2;

    var rows = [
      ['Customer ID', c.code || '-'],
      ['Customer Name', c.name || '-'],
      ['Mobile No', c.mobile || '-']
    ];

    setFont(doc, 'normal', 8, NAVY);
    var addressLines = doc.splitTextToSize(String(c.address || '-'), narrow - pad * 2);
    var addressX = x + wide + 2 + pad;

    // Both boxes share one height. The rows on the left are a fixed rhythm, so
    // they simply stop early when the address is the longer of the two.
    var leftHeight = rows.length * 6 + 3;
    var addressHeight = 9.8 + addressLines.length * 3.8 + 1.6;
    var boxHeight = Math.max(leftHeight, addressHeight);

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.rect(x, y, wide, boxHeight);
    doc.rect(x + wide + 2, y, narrow, boxHeight);

    rows.forEach(function (row, i) {
      var ry = y + 5 + i * 6;
      setFont(doc, 'normal', 6.5, MUTED);
      doc.text(String(row[0]).toUpperCase(), x + pad, ry);
      setFont(doc, 'bold', 8.5, NAVY);
      doc.text(String(row[1]), x + 26, ry, { maxWidth: wide - 26 - pad });
      hairline(doc, x + 0.3, ry + 1.9, x + wide - 0.3, [240, 233, 216], 0.15);
    });

    // The address label sits on the same baseline as the first row label, so the
    // two boxes read as one row of headings rather than two unrelated lists.
    setFont(doc, 'normal', 6.5, MUTED);
    doc.text('ADDRESS', addressX, y + 5);
    setFont(doc, 'normal', 8, NAVY);
    doc.text(addressLines, addressX, y + 9.8);

    return y + boxHeight + 3;
  }

  /* The same columns, in the same proportions and on the same sides, as the
   * printed bill at PRINT_CSS. A PDF that lines its numbers up differently from
   * the sheet the shopkeeper has just compared it against reads as a mistake. */
  var COLUMNS = [
    { key: 'no', label: '#', w: 0.06, align: 'right' },
    { key: 'code', label: 'Order ID', w: 0.14, align: 'right' },
    { key: 'item', label: 'Dress Type', w: 0.22, align: 'left' },
    { key: 'delivery', label: 'Delivery', w: 0.14, align: 'right' },
    { key: 'qty', label: 'Qty', w: 0.08, align: 'right' },
    { key: 'rate', label: 'Rate', w: 0.12, align: 'right' },
    { key: 'disc', label: 'Disc', w: 0.10, align: 'right' },
    { key: 'amount', label: 'Amount', w: 0.14, align: 'right' }
  ];

  function tableHeader(doc, x, right, y) {
    var width = right - x;
    doc.setFillColor.apply(doc, NAVY);
    doc.rect(x, y, width, 7, 'F');

    var cx = x;
    COLUMNS.forEach(function (col) {
      var cw = width * col.w;
      setFont(doc, 'bold', 6.5, [255, 253, 247]);
      doc.text(col.label.toUpperCase(), col.align === 'right' ? cx + cw - 1.5 : cx + 1.5,
        y + 4.6, { align: col.align, maxWidth: cw - 3 });
      cx += cw;
    });

    return y + 7;
  }

  /* One garment line. Returns the height it used, so the caller knows whether
   * the next line still fits on the page.
   *
   * Every cell is measured, not only the garment name. A rate that wraps would
   * otherwise print its second line below the border of its own row, which is
   * the one alignment fault a customer is likely to notice on a bill. */
  var ROW_LEAD = 3.6;
  var ROW_PAD = 2.6;

  function rowLines(doc, width, row) {
    var cellText = [row.no, row.code, row.item, row.delivery, row.qty, row.rate, row.disc, row.amount];

    return cellText.map(function (value, i) {
      var text = String(value == null ? '' : value);
      if (!text) return [''];
      return doc.splitTextToSize(text, width * COLUMNS[i].w - 3);
    });
  }

  function rowHeight(lines) {
    var tallest = lines.reduce(function (most, l) { return Math.max(most, l.length); }, 1);
    return Math.max(7, tallest * ROW_LEAD + ROW_PAD);
  }

  function itemRow(doc, snap, x, right, y, row, shaded) {
    var width = right - x;
    var lines = rowLines(doc, width, row);
    var height = rowHeight(lines);

    // The band is drawn to the measured height, so a row that had to grow for a
    // long garment name is shaded all the way down rather than to a fixed depth.
    if (shaded) {
      doc.setFillColor(250, 248, 243);
      doc.rect(x, y, width, height, 'F');
    }

    var cx = x;
    COLUMNS.forEach(function (col, i) {
      var cw = width * col.w;
      var bold = (i === 2 || i === 7);
      setFont(doc, bold ? 'bold' : 'normal', bold ? 8 : 7.5, bold ? NAVY : INK);
      doc.text(lines[i], col.align === 'right' ? cx + cw - 1.5 : cx + 1.5,
        y + ROW_PAD + ROW_LEAD - 0.8, { align: col.align });
      cx += cw;
    });

    doc.setDrawColor.apply(doc, [220, 208, 174]);
    doc.setLineWidth(0.15);
    doc.rect(x, y, width, height, 'S');

    return height;
  }

  /* The totals, in the same ruled box as the printed bill. The discount is only
   * listed when there is one, exactly as PRINT_CSS does it: a line reading
   * "Discount - Rs. 0.00" on every bill trains the eye to skip the line that
   * matters.
   *
   * height is the height of the box beside it, so the two boxes start and end
   * together. The rows are spread through it rather than stacked at the top, so
   * the balance - the figure the customer is actually asked for - finishes level
   * with the foot of the payment box. */
  function totals(doc, snap, x, right, y, height) {
    var bill = snap.bill || {};
    var rows = [['Sub Total', money(bill.total)]];
    if (num(bill.discount)) rows.push(['Discount', '- ' + money(bill.discount)]);
    rows.push(['Total Amount', money(bill.bill_amount)]);
    rows.push(['Total Paid', money(bill.advance)]);
    rows.push(['Balance Amount', money(bill.balance)]);

    var width = right - x;
    var needed = rows.length * 6 + 8;
    height = Math.max(needed, num(height));
    var step = rows.length > 1 ? (height - 10) / (rows.length - 1) : 6;

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.rect(x, y, width, height);

    rows.forEach(function (row, i) {
      var ry = y + 5 + step * i;
      var last = i === rows.length - 1;

      if (last) {
        doc.setFillColor(251, 246, 234);
        doc.rect(x + 0.2, ry - 3.6, width - 0.4, 5.6, 'F');
        hairline(doc, x + 0.3, ry - 3.6, x + width - 0.3, GOLD, 0.4);
        hairline(doc, x + 0.3, ry + 2, x + width - 0.3, GOLD, 0.4);
      }

      setFont(doc, last ? 'bold' : 'normal', last ? 10 : 8.5, last ? NAVY : MUTED);
      doc.text(row[0], x + 2.5, ry);
      setFont(doc, 'bold', last ? 10 : 8.5, NAVY);
      doc.text(row[1], x + width - 2.5, ry, { align: 'right' });
    });

    return height;
  }

  /* The UPI box: the id, the amount, and a QR the customer can scan.
   *
   * The measurements are taken first and the box is then sized from them. It used
   * to be given a fixed height while the code and its caption were placed at
   * fixed offsets below that height, so the QR hung outside the bottom of its own
   * box on every single bill. */
  var CARD_PAD = 2.5;
  var CARD_QR = 16;

  function cardPlan(doc, snap, width) {
    var bill = snap.bill || {};
    var shop = snap.shop || {};

    var hint = bill.method
      ? ('Method: ' + bill.method + (bill.paid_on ? (' · ' + dateLabel(bill.paid_on)) : ''))
      : 'Any UPI app';

    // The QR shares the row with the caption, so the text above it is measured
    // against the space actually left rather than the whole width.
    var hintLines = doc.splitTextToSize(hint, width - CARD_PAD * 2 - CARD_QR - 4);
    var qrY = 19.4 + hintLines.length * 3.4 + 2;
    var captionY = qrY + CARD_QR + 3.2;

    return {
      shop: shop,
      hint: hint,
      hintLines: hintLines,
      qrY: qrY,
      captionY: captionY,
      height: captionY + 2
    };
  }

  function payCard(doc, snap, x, right, y) {
    var width = right - x;
    var plan = cardPlan(doc, snap, width);

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 253, 247);
    doc.rect(x, y, width, plan.height, 'FD');

    setFont(doc, 'bold', 6.5, GOLD);
    doc.text('PAYMENT DETAILS', x + CARD_PAD, y + 5);

    setFont(doc, 'normal', 7, MUTED);
    doc.text('UPI ID', x + CARD_PAD, y + 10);
    setFont(doc, 'bold', 8, NAVY);
    doc.text(plan.shop.upiId || '-', x + CARD_PAD + 17, y + 10, { maxWidth: width - CARD_PAD * 2 - 17 });

    if (snap.dueLabel) {
      setFont(doc, 'bold', 11, GOLD);
      doc.text('Pay ' + money(snap.dueLabel), x + CARD_PAD, y + 15.6);
    }

    setFont(doc, 'normal', 7, MUTED);
    doc.text(plan.hintLines, x + CARD_PAD, y + 19.4);

    if (qr(doc, snap.payLink, x + CARD_PAD, y + plan.qrY, CARD_QR)) {
      setFont(doc, 'normal', 6.5, MUTED);
      doc.text('Scan to pay', x + CARD_PAD + CARD_QR / 2, y + plan.captionY, { align: 'center' });
    }

    return plan.height;
  }

  /* The Instagram block, printed only when the shop has set a handle. It is given
   * its own column and its own left edge, rather than measuring one back from
   * the right of the row - measuring back from the right put its border about a
   * millimetre inside the totals box beside it. */
  function followCard(doc, snap, x, width, y, height) {
    if (width < 22) return 0;

    var cx = x + width / 2;
    var qrSide = Math.min(14, width - 6);

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 255, 255);
    doc.rect(x, y, width, height, 'FD');

    setFont(doc, 'bold', 6.5, GOLD);
    doc.text('FOLLOW US', cx, y + 5, { align: 'center' });

    // Centred in the box it was given, so a box stretched level with a taller
    // payment box does not leave the code hanging off the top of it.
    var handle = '@' + ((snap.shop || {}).instagram || '');
    setFont(doc, 'bold', 7, NAVY);
    var content = 4.6 + 1.6 + qrSide + 4.4;
    var top = y + Math.max(6, (height - content) / 2);

    qr(doc, snap.instagramUrl, cx - qrSide / 2, top, qrSide);
    doc.text(handle, cx, top + qrSide + 4, { align: 'center', maxWidth: width - 4 });

    return height;
  }

  /* The footer, repeated at the foot of the last page. */
  function footer(doc, snap, x, right, y) {
    var shop = snap.shop || {};
    var cx = (x + right) / 2;

    hairline(doc, cx - 30, y, cx + 30, GOLD_SOFT, 0.2);
    setFont(doc, 'bold', 11, NAVY);
    doc.text(String(shop.name || 'AN TAILOR').toUpperCase(), cx, y + 6, { align: 'center' });
    setFont(doc, 'normal', 8, GOLD);
    doc.text('Thank you for choosing us', cx, y + 10, { align: 'center' });

    var line = [shop.phone, shop.email, shop.instagram ? ('@' + shop.instagram) : '']
      .filter(Boolean).join('   ·   ');
    if (line) {
      setFont(doc, 'normal', 7, MUTED);
      doc.text(line, cx, y + 14, { align: 'center', maxWidth: right - x });
    }
  }

  /* Rows for the items table, flattened across every order on the bill. A
   * garment the shop never listed still gets a line, so the bill never looks
   * short a garment because a read came back empty. */
  function itemRows(snap) {
    var rows = [];
    var orders = snap.orders || [];
    var n = 0;

    orders.forEach(function (order) {
      var items = (order.items || []);
      if (!items.length) {
        rows.push({
          no: ++n, code: order.code, item: 'No garments listed for this order',
          delivery: dateLabel(order.delivery_date), qty: '', rate: '', disc: '', amount: ''
        });
        return;
      }
      items.forEach(function (it) {
        var note = [];
        if (it.variant) note.push(it.variant);
        if (it.lining) note.push(it.lining + ' lining');
        if (it.service && it.service !== 'Tailoring') note.push(it.service);

        var name = it.dress_type || it.category || 'Garment';
        if (note.length) name += ' · ' + note.join(' · ');

        rows.push({
          no: ++n, code: order.code, item: name,
          delivery: dateLabel(order.delivery_date),
          qty: String(it.quantity == null ? '' : it.quantity),
          rate: money(it.line_total), disc: money(0), amount: money(it.line_total)
        });
      });
    });

    if (!rows.length) {
      rows.push({
        no: '', code: '', item: 'No orders are recorded on this bill',
        delivery: '', qty: '', rate: '', disc: '', amount: ''
      });
    }
    return rows;
  }

  /* Draws the bill and resolves with the finished Blob. */
  function build(jsPDF, snap) {
    var sheet = SHEETS[String(snap.printSize || 'A4').toUpperCase()] || SHEETS.A4;
    var w = sheet[0];
    var h = sheet[1];
    var x = 12;
    var right = w - 12;

    // The footer is a fixed band at the foot of the last page, so it is reserved
    // before anything else is placed and content is kept clear of it. Choosing
    // the footer's position from wherever the content happened to end used to
    // print a note straight through the shop's name on a long bill.
    var footerY = h - 30;
    var floor = footerY - 4;

    var doc = new jsPDF({
      unit: 'mm',
      format: [w, h],
      orientation: 'portrait',
      compress: true
    });

    doc.setProperties({
      title: (snap.bill && snap.bill.code) || 'Bill',
      creator: 'AN Tailor',
      subject: 'Bill'
    });

    function nextBlock(y, need) {
      if (y + need > floor) {
        doc.addPage();
        frame(doc, w, h);
        return 20;
      }
      return y;
    }

    frame(doc, w, h);
    var y = masthead(doc, snap, x, right, 13);
    y = billBar(doc, snap, x, right, y);

    y = sectionTitle(doc, 'Customer Details', x, y, right);
    y = parties(doc, snap, x, right, y);

    y = sectionTitle(doc, 'Garments', x, y + 1, right);
    y = tableHeader(doc, x, right, y);

var rows = itemRows(snap);
    rows.forEach(function (row, i) {
      // Measured before it is drawn, so a row that needs more than one line is
      // never left straddling the foot of the page.
      var rowH = rowHeight(rowLines(doc, right - x, row));
      if (y + rowH > floor) {
        doc.addPage();
        frame(doc, w, h);
        y = tableHeader(doc, x, right, 20);
      }
      y += itemRow(doc, snap, x, right, y, row, i % 2 === 1);
    });

    y += 4;

    /* The totals sit on the right, level with the payment box on the left, so
     * the balance the customer is asked for is the most prominent figure in the
     * lower half of the page. The boxes are laid out from explicit edges and one
     * shared gap: measuring the follow box back from the right of the row used to
     * put its border inside the totals box beside it. */
    var gap = 2;
    var span = right - x;
    var followWidth = snap.instagramUrl && span > 150 ? Math.min(30, span * 0.15) : 0;
    var usable = span - (followWidth ? gap * 2 : gap) - followWidth;
    var payWidth = usable * 0.54;
    var totalsWidth = usable - payWidth;
    var payRight = x + payWidth;
    var totalsLeft = payRight + gap;
    var totalsRight = followWidth ? totalsLeft + totalsWidth : right;
    var followLeft = totalsRight + gap;

    var cardHeight = cardPlan(doc, snap, payWidth).height;
    if (y + cardHeight > floor) {
      doc.addPage();
      frame(doc, w, h);
      y = 20;
    }

    payCard(doc, snap, x, payRight, y);
    totals(doc, snap, totalsLeft, totalsRight, y, cardHeight);
    if (followWidth) followCard(doc, snap, followLeft, followWidth, y, cardHeight);

    y += cardHeight + 4;

    if (snap.words) {
      setFont(doc, 'italic', 7.5, MUTED);
      var words = doc.splitTextToSize(String(snap.words), right - x);
      y = nextBlock(y, words.length * 3.6 + 3);
      doc.text(words, x, y + 3);
      y += words.length * 3.6 + 3;
    }

    if (snap.notes) {
      setFont(doc, 'normal', 8, INK);
      var noteLines = doc.splitTextToSize(String(snap.notes), right - x - 6);
      var noteHeight = noteLines.length * 3.6 + 4;
      y = nextBlock(y, noteHeight);
      doc.setFillColor(247, 244, 234);
      doc.rect(x, y, right - x, noteHeight, 'F');
      doc.setFillColor.apply(doc, GOLD);
      doc.rect(x, y, 0.8, noteHeight, 'F');
      doc.text(noteLines, x + 3, y + 5);
      y += noteHeight + 3;
    }

    footer(doc, snap, x, right, footerY);

    return doc.output('blob');
  }

  /* The logo is read before the page is drawn, so a logo that will not load
   * costs nothing but a slightly narrower masthead. */
  function render(snap) {
    return library()
      .then(function (jsPDF) {
        return logoData(snap.logoUrl).then(function (data) {
          snap.logoData = data;
          return build(jsPDF, snap);
        });
      });
  }

  return {
    render: render,
    library: library,
    /* Used by the test harness and by the retry path, which wants to know a PDF
     * was actually produced before it goes near the network. */
    rows: itemRows
  };
})();
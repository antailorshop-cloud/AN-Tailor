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

  /* Customer details beside the address, each in its own ruled box. */
  function parties(doc, snap, x, right, y) {
    var c = snap.customer || {};
    var wide = (right - x) * 0.56;
    var narrow = right - x - wide - 2;

    var rows = [
      ['Customer ID', c.code || '-'],
      ['Customer Name', c.name || '-'],
      ['Mobile No', c.mobile || '-']
    ];

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.rect(x, y, wide, rows.length * 6 + 2);
    doc.rect(x + wide + 2, y, narrow, rows.length * 6 + 2);

    rows.forEach(function (row, i) {
      var ry = y + 5 + i * 6;
      setFont(doc, 'normal', 6.5, MUTED);
      doc.text(String(row[0]).toUpperCase(), x + 2, ry);
      setFont(doc, 'bold', 8.5, NAVY);
      doc.text(String(row[1]), x + 26, ry, { maxWidth: wide - 28 });
      hairline(doc, x + 0.3, ry + 1.9, x + wide - 0.3, [240, 233, 216], 0.15);
    });

    setFont(doc, 'normal', 6.5, MUTED);
    doc.text('ADDRESS', x + wide + 4, y + 4.6);
    setFont(doc, 'normal', 8, NAVY);
    var lines = doc.splitTextToSize(String(c.address || '-'), narrow - 4);
    doc.text(lines, x + wide + 4, y + 8.6);

    return y + rows.length * 6 + 6;
  }

  var COLUMNS = [
    { key: 'no', label: '#', w: 0.06, align: 'right' },
    { key: 'code', label: 'Order ID', w: 0.15, align: 'right' },
    { key: 'item', label: 'Dress Type', w: 0.25, align: 'left' },
    { key: 'delivery', label: 'Delivery', w: 0.14, align: 'right' },
    { key: 'qty', label: 'Qty', w: 0.07, align: 'right' },
    { key: 'rate', label: 'Rate', w: 0.11, align: 'right' },
    { key: 'disc', label: 'Disc', w: 0.10, align: 'right' },
    { key: 'amount', label: 'Amount', w: 0.12, align: 'right' }
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
   * the next line still fits on the page. */
  function itemRow(doc, snap, x, right, y, row, shaded) {
    var width = right - x;
    var cellText = [row.no, row.code, row.item, row.delivery, row.qty, row.rate, row.disc, row.amount];

    if (shaded) {
      doc.setFillColor(250, 248, 243);
      doc.rect(x, y, width, 7, 'F');
    }

    var cx = x;
    var itemLines = doc.splitTextToSize(String(row.item || ''), width * COLUMNS[2].w - 3);
    var height = Math.max(7, itemLines.length * 3.6 + 2.6);

    COLUMNS.forEach(function (col, i) {
      var cw = width * col.w;
      var bold = (i === 2 || i === 7);
      setFont(doc, bold ? 'bold' : 'normal', bold ? 8 : 7.5, bold ? NAVY : INK);
      doc.text(i === 2 ? itemLines : String(cellText[i] == null ? '' : cellText[i]),
        col.align === 'right' ? cx + cw - 1.5 : cx + 1.5,
        y + 4.7, { align: col.align, maxWidth: cw - 3 });
      cx += cw;
    });

    doc.setDrawColor.apply(doc, [220, 208, 174]);
    doc.setLineWidth(0.15);
    doc.rect(x, y, width, height, 'S');

    return height;
  }

  /* The totals, in the same ruled box on the printed bill. */
  function totals(doc, snap, x, right, y) {
    var bill = snap.bill || {};
    var rows = [
      ['Sub Total', money(bill.total)],
      ['Total Amount', money(bill.bill_amount)],
      ['Total Paid', money(bill.advance)],
      ['Balance Amount', money(bill.balance)]
    ];

    var width = right - x;
    var height = rows.length * 6 + 8;
    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.rect(x, y, width, height);

    rows.forEach(function (row, i) {
      var ry = y + 5 + i * 6;
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

  /* The UPI box: the amount, the id, and a QR the customer can scan. */
  function payCard(doc, snap, x, right, y) {
    var bill = snap.bill || {};
    var shop = snap.shop || {};
    var width = right - x;
    var boxWidth = (width - 2) * 0.52;
    var qrSide = 17;
    var boxHeight = 8 + qrSide + 6;

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 253, 247);
    doc.rect(x, y, boxWidth, boxHeight, 'FD');

    setFont(doc, 'bold', 6.5, GOLD);
    doc.text('PAYMENT DETAILS', x + 2.5, y + 5);

    setFont(doc, 'normal', 7, MUTED);
    doc.text('UPI ID', x + 2.5, y + 12);
    setFont(doc, 'bold', 8, NAVY);
    doc.text(shop.upiId || '-', x + 20, y + 12);

    if (snap.dueLabel) {
      setFont(doc, 'bold', 11, GOLD);
      doc.text('Pay ' + money(snap.dueLabel), x + 2.5, y + 18);
    }

    setFont(doc, 'normal', 7, MUTED);
    var hint = bill.method ? ('Method: ' + bill.method + (bill.paid_on ? (' · ' + dateLabel(bill.paid_on)) : '')) : 'Any UPI app';
    doc.text(hint, x + 2.5, y + 23, { maxWidth: boxWidth - 8 });

    qr(doc, snap.payLink, x + 2.5, y + 26, qrSide);
    setFont(doc, 'normal', 6.5, MUTED);
    doc.text('Scan to pay', x + 2.5 + qrSide / 2, y + 26 + qrSide + 3.4, { align: 'center' });

    return boxHeight;
  }

  /* The Instagram block, printed only when the shop has set a handle. */
  function followCard(doc, snap, x, right, y, height) {
    var width = right - x;
    var boxWidth = width - (width - 2) * 0.52 - 2;
    if (boxWidth < 22) return;

    doc.setDrawColor.apply(doc, GOLD_SOFT);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 255, 255);
    doc.rect(x + width - boxWidth, y, boxWidth, height, 'FD');

    var cx = x + width - boxWidth / 2;
    var qrSide = 14;

    setFont(doc, 'bold', 6.5, GOLD);
    doc.text('FOLLOW US', cx, y + 5, { align: 'center' });

    qr(doc, snap.instagramUrl, cx - qrSide / 2, y + 7, qrSide);

    setFont(doc, 'bold', 7, NAVY);
    doc.text('@' + (snap.shop.instagram || ''), cx, y + 7 + qrSide + 4, { align: 'center', maxWidth: boxWidth - 4 });
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
    var floor = h - 16;

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

    frame(doc, w, h);
    var y = masthead(doc, snap, x, right, 13);
    y = billBar(doc, snap, x, right, y);

    y = sectionTitle(doc, 'Customer Details', x, y, right);
    y = parties(doc, snap, x, right, y);

    y = sectionTitle(doc, 'Garments', x, y + 1, right);
    y = tableHeader(doc, x, right, y);

    var rows = itemRows(snap);
    rows.forEach(function (row, i) {
      if (y + 8 > floor) {
        doc.addPage();
        frame(doc, w, h);
        y = 20;
        y = tableHeader(doc, x, right, y);
      }
      y += itemRow(doc, snap, x, right, y, row, i % 2 === 1);
    });

    y += 4;
    if (y + 34 > floor) {
      doc.addPage();
      frame(doc, w, h);
      y = 20;
    }

    /* The totals sit on the right, level with the payment box on the left, so
     * the balance the customer is asked for is the most prominent figure in
     * the lower half of the page. */
    var totalsLeft = x + (right - x) * 0.52;
    var payHeight = payCard(doc, snap, x, totalsLeft - 2, y);
    var totalsHeight = totals(doc, snap, totalsLeft, right, y);
    if (snap.instagramUrl) followCard(doc, snap, x, right, y, Math.max(payHeight, totalsHeight));

    y += Math.max(payHeight, totalsHeight) + 4;

    if (snap.words) {
      if (y + 12 > floor) {
        doc.addPage();
        frame(doc, w, h);
        y = 20;
      }
      setFont(doc, 'italic', 7.5, MUTED);
      var words = doc.splitTextToSize(String(snap.words), right - x);
      doc.text(words, x, y + 3);
      y += words.length * 3.6 + 3;
    }

    if (snap.notes) {
      if (y + 12 > floor) {
        doc.addPage();
        frame(doc, w, h);
        y = 20;
      }
      doc.setFillColor(247, 244, 234);
      var noteLines = doc.splitTextToSize(String(snap.notes), right - x - 6);
      var noteHeight = noteLines.length * 3.6 + 4;
      doc.rect(x, y, right - x, noteHeight, 'F');
      doc.setFillColor.apply(doc, GOLD);
      doc.rect(x, y, 0.8, noteHeight, 'F');
      setFont(doc, 'normal', 8, INK);
      doc.text(noteLines, x + 3, y + 5);
      y += noteHeight + 3;
    }

    footer(doc, snap, x, right, Math.max(y + 2, floor - 14));

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
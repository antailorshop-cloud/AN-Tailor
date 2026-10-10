/* AN TAILOR - bill print size.
 *
 * A tailoring bill is not always printed on a full A4 page. A small shop often
 * prints on A5 because the paper is cheaper, or prints one A5 bill on the left
 * half of a landscape A4 sheet and reuses the blank half. The legacy system
 * offered exactly these three, and the choice is stored in shop_settings under
 * bill_print_size so it survives a reload and reaches every phone.
 *
 *   A4      one full portrait A4 page
 *   A5      one full portrait A5 page, the bill narrowed to suit it
 *   A4HALF  an A4 sheet in landscape carrying one A5 bill on the LEFT half, a
 *           dashed line down the centre marking the cut, and the right half
 *           deliberately left blank so it can be cut off and printed on again
 *
 * The size only ever affects how the document is laid out; it never changes a
 * figure on it. That is why this is a separate module from the bill itself.
 */

window.ANT = window.ANT || {};

window.ANT.printsize = (function () {
  var DEFAULT = 'A4';

  /* The sheet a bill is shared on, when the shop has not said otherwise.
   *
   * The bill is printed on a full sheet and sent on a half one. They are the same
   * document at two sizes - the same rules, the same type, the same drawing - but
   * the sheet a phone is asked to open is not the sheet a printer is fed, and an
   * A4 bill opened on a phone is a screen of zoom with no way to read a total.
   * The sheet that goes out to a customer is therefore the small one by default,
   * and the shop can still put it on A4 from Settings if that is what it prefers. */
  var SHARE_DEFAULT = 'A5';

  /* The white margin between the edge of the paper and the bill's frame.
   *
   * A printer cannot reach the edge of a sheet, so a bill drawn hard against the
   * trim comes out with its frame shaved off by one shop's printer and whole on
   * another's. Five millimetres is inside what every desktop and inkjet can reach
   * without scaling, and it is the same on all three sizes so a bill does not look
   * like a different document when it is printed on the smaller sheet.
   *
   * It lives here, and only here, because three separate places need to agree
   * about it: the @page rule the printer obeys, the width and height the bill is
   * laid out to, and the offset the PDF is drawn at. If those were written out
   * separately they would drift, and the drift would only show up as a PDF whose
   * margins do not match its own print. */
  var GAP_MM = 5;

  // Ordered as they are offered in Settings, smallest sheet last because that is
  // the one a shop picks when it has thought about paper.
  //
  // Each size carries a second wording for the receipt, because the same sheet
  // means something different for a slip: half an A4 is two bills on one sheet
  // but a cut line between two receipts, and saying "A5 bill on the left" beside
  // a receipt box would be a small lie on the screen.
  var SIZES = [
    { key: 'A4', label: 'A4 - Full page', receipt: 'A4 - Full page' },
    { key: 'A5', label: 'A5 - Full A5 sheet', receipt: 'A5 - Full A5 sheet' },
    {
      key: 'A4HALF',
      label: 'A4 sheet - A5 bill on the left (cut & reuse)',
      receipt: 'A4 sheet - two receipts, cut apart (A5)'
    }
  ];

  // A receipt defaults to A5. A full A4 for a small cash payment wastes a sheet,
  // and the half-sheet option needs a printer that will take the page sideways,
  // which is not something to discover at the counter. A5 prints on any printer
  // that can already print the shop's bills.
  var RECEIPT_DEFAULT = 'A5';

  /* Understands the spellings the legacy sheet may already hold, so a stored
   * value from the old system is never read as an unknown size. Anything
   * unrecognised falls back to the caller's default rather than printing at some
   * guessed size, which is what lets a receipt ask for A5 through the same code
   * that gives a bill A4. */
  function normalize(value, fallback) {
    var key = String(value == null ? '' : value)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (key === 'A5' || key === 'HALFA4' || key === 'A4A5') return 'A5';
    if (key === 'A4HALF' || key === 'HALF' || key === 'A4SHEET' || key === 'SHEET') return 'A4HALF';
    if (key === 'A4') return 'A4';

    var alt = String(fallback == null ? '' : fallback)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (alt === 'A5') return 'A5';
    if (alt === 'A4HALF' || alt === 'HALF' || alt === 'A4SHEET' || alt === 'SHEET') return 'A4HALF';
    if (alt === 'A4') return 'A4';
    return DEFAULT;
  }

  function label(value, kind) {
    var key = normalize(value);
    for (var i = 0; i < SIZES.length; i++) {
      if (SIZES[i].key !== key) continue;
      return kind === 'receipt' ? SIZES[i].receipt : SIZES[i].label;
    }
    return key;
  }

  /* The @page rule. The page margin is set here and the printed body margin is
   * zeroed by the caller, so the two cannot stack into a double margin - the
   * margin below is the whole of the gap, and the bill itself carries none. */
  function pageCss(value) {
    var key = normalize(value);
    if (key === 'A5') return '@page{size:A5 portrait;margin:' + GAP_MM + 'mm}';
    if (key === 'A4HALF') return '@page{size:A4 landscape;margin:' + GAP_MM + 'mm}';
    return '@page{size:A4 portrait;margin:' + GAP_MM + 'mm}';
  }

/* How tall the printable area of each sheet is, in millimetres: the paper height
   * less the margin on both edges. This is what the auto-fit on the bill measures
   * itself against, so a bill with four garments and one with nine are both told
   * the same target.
   *
   *   A4      297mm paper less 5mm top and bottom  -> 287mm
   *   A5      210mm paper less 5mm top and bottom  -> 200mm
   *   A4HALF  A4 turned sideways, same as A5        -> 200mm
   *
   * It is exported rather than kept private so the bill can ask for it and the
   * harness can check the arithmetic, which is the kind of number that is easy to
   * get subtly wrong and hard to see on paper. */
  function pageHeightMm(value) {
    var key = normalize(value);
    if (key === 'A5') return 210 - GAP_MM * 2;
    if (key === 'A4HALF') return 210 - GAP_MM * 2;
    return 297 - GAP_MM * 2;
  }

  /* The white gap between the bill and the cut line on a half sheet.
   *
   * The bill is laid out to stop short of the middle of the paper, and the cut line
   * is drawn down that middle, and there is a gap between them on purpose.
   *
   * They used to meet. The bill's width was the half sheet less one margin, which
   * put its right-hand edge exactly on the line the scissors are meant to follow,
   * and its top and bottom borders ran right up to it. Two lines that touch print
   * as one thick line: the border and the cut guide read as a single smudge along
   * the edge of the paper, and it is impossible to see where the bill stops and the
   * cut begins - which is the one thing a cut-and-reuse sheet has to make obvious.
   *
   * A few millimetres of paper between them fixes it. The gap is white on both
   * sides of a dashed line, so the eye reads three things - a frame, a space, a cut
   * - instead of one blurred edge, and the tailor can see at a glance which half is
   * the bill and which half is to be reused. */
  var CUT_GAP_MM = 4;

  /* How wide the bill is laid out, in millimetres. The auto-fit on the bill sets
   * the measuring window to this before it measures anything, because a bill
   * measured on a wide screen wraps its garment names differently than the same
   * bill on a 190mm sheet - so without it the fit would be calculated against a
   * layout the printer never uses.
   *
   *   A4      210mm paper less 5mm left and right  -> 200mm
   *   A5      148mm paper less 5mm left and right  -> 138mm
   *   A4HALF  the left half of a landscape A4, less the 5mm margin on its left,
   *           the 5mm the cut line is inset by, and the gap that keeps the bill's
   *           border off the cut                       -> 139mm
   *
   * These are the same numbers layoutCss() puts in the stylesheet, kept here as
   * values so a change to the layout and a change to the measurement cannot drift
   * apart unnoticed. */
  function billWidthMm(value) {
    var key = normalize(value);
    if (key === 'A5') return 148 - GAP_MM * 2;
    // 148.5mm is the middle of a landscape A4 and the cut line goes there, so
    // one usable half is exactly the other. The bill stops short of the cut by
    // CUT_GAP_MM, and the frame draws no right border: the cut line is the edge
    // the half sheet is read by, and a frame closing itself a few millimetres
    // short of it reads as an unfinished box.
    if (key === 'A4HALF') return 148.5 - GAP_MM - CUT_GAP_MM;
    return 210 - GAP_MM * 2;
  }

  /* The layout rule for the printed body, given its own class so nothing else on
   * the page is narrowed by a print size. The class defaults to the bill's, so
   * bills.js is unaffected, and a receipt passes its own. */
  function layoutCss(value, className) {
    var key = normalize(value);
    var base = className || 'bill';

    if (key === 'A4HALF') {
      /* The bill frames all four of its sides. The cut line runs down the middle
       * of the paper, well clear of the bill's right edge, so a closed frame is
       * the frame the half sheet is meant to read - an open one looks like the
       * bill has been trimmed.
       *
       * The bill is laid against the page's own left margin and its width stops
       * short of the cut, so the paper either side of the cut is even.
       *
       * The half sheet is only 200mm tall and the ordinary bill's own stamp band
       * (25mm) is measured for a full A4, so on a half the band is cut back and
       * the head, the rules and the section gaps are drawn in a little. Left
       * alone the bill needs 219mm - longer than the paper - and fitToOnePage
       * answers that by shrinking the whole thing to 91%, which is what left the
       * white gap down the side. Tightened, it lands at 200mm and prints true. */
      return '.' + base + '-half{width:' + billWidthMm(key) + 'mm;min-height:' + pageHeightMm(key) + 'mm;' +
        'padding:4.5mm 4.5mm 12mm;margin-left:0;margin-right:0}' +
        '.' + base + '-half .stamp{bottom:6mm;right:6mm}' +
        '.' + base + '-half .orn{margin-top:1mm}' +
        '.' + base + '-half .bill-bar{margin:2mm 0 1.5mm}' +
        '.' + base + '-half .sect{margin:1.5mm 0 1.5mm}' +
        '.' + base + '-half .parties{margin:3mm 0 2mm}' +
        cutCss();
    }

  /* The cut line, for a bill printed as a page rather than as a file.
   *
   * billpdf draws this line into the PDF itself, because a file has no @page rule
   * to hang a rule on. A page does, so on this path it is a rule in the stylesheet
   * instead - the same line, in the same place, drawn by the other hand.
   *
   * It sits on the middle of the paper rather than beside the bill, and that works
   * out exactly: @page leaves 5mm at each edge of a landscape A4, so the middle of
   * the 287mm the page is left with is the middle of the 297mm sheet. Half of
   * nothing would be a poor place to cut; half of the page is the paper's own
   * middle, which is the whole point of a cut-and-reuse sheet.
   *
   * It is under @media print so it cannot be seen on the screen, where a dashed
   * rule down the page would look like a fault in the layout. */
  function cutCss() {
    return '@media print{body{position:relative}' +
      'body:after{content:"";position:absolute;left:50%;top:0;bottom:0;' +
      'border-left:0.5mm dashed #0f2239}}';
  }

    /* max-width is 100%, not the same figure as the width again.
     *
     * Setting it to the width the rule already has makes it a rule that can never do
     * anything. Setting it to 100% lets the bill give way instead: a printer set to
     * its own idea of the margin hands over a narrower box than @page asked for, and
     * a bill that insisted on its full width would hang off the side of the paper
     * rather than print a little narrower and still centred. A bill squeezed is a
     * smaller bill; a bill printed off the edge of the paper is not a bill. */
    /* A5 gets the same tightening as the half sheet. Its page is also 200mm tall,
     * but the ordinary bill's 25mm stamp band and full section gaps overshoot it
     * just the same. The file is rescued by fitToOnePage; a printed page is not,
     * so the browser shrinks the whole bill to fit and leaves a gap at the bottom
     * and side. These rules pull it to 200mm so it prints true instead.
     *
     * They say .bill, not a class of their own, because the body markup is the
     * same document on every sheet - the sheet is named only here. This block is
     * handed to the A5 document alone, so the plain selector is already scoped. */
    if (key === 'A5') return '.' + base + '{width:' + billWidthMm(key) + 'mm;max-width:100%' +
      (base === 'bill' ? ';min-height:' + pageHeightMm(key) + 'mm' : '') + '}' +
      '.' + base + '{padding:4.5mm 4.5mm 12mm}' +
      '.' + base + ' .stamp{bottom:6mm;right:6mm}' +
      '.' + base + ' .orn{margin-top:1mm}' +
      '.' + base + ' .bill-bar{margin:2mm 0 1.5mm}' +
      '.' + base + ' .sect{margin:1.5mm 0 1.5mm}' +
      '.' + base + ' .parties{margin:3mm 0 2mm}' +
      centreCss(base);
    return '.' + base + '{width:' + billWidthMm(key) + 'mm;max-width:100%' +
      (base === 'bill' ? ';min-height:' + pageHeightMm(key) + 'mm' : '') + '}' + centreCss(base);
  }

  /* The bill on the middle of its paper.
   *
   * These sheets are cut and reused, so a bill printed into the corner of one is a
   * bill printed on a sheet the tailor then trims, and the trim is not always
   * straight. It also just looks wrong: white paper down the right and along the
   * bottom, and the frame nowhere near the middle of the thing it is drawn on.
   *
   * What makes this awkward is that the bill is not told how much paper the printer
   * will give it. @page asks for 5mm, and a printer set to its own idea of the
   * margin gives something else - wider, usually. A bill pinned with margin:0 then
   * sits in the top-left of whatever it is given, and the gap lands all on one side.
   * Centring on the paper itself is the only thing that survives a printer that
   * disagrees: margin:auto puts the same white space on the right as on the left,
   * and the bill stays in the middle of the sheet however the margins come out.
   *
   * Up and down it is a row of one, so the same auto margins centre a short receipt
   * on its sheet. justify-content is 'safe center' rather than plain 'center' on
   * purpose: a receipt taller than the page - and a long bill can be, however hard
   * the auto-fit squeezes - would have its top cut off and be unreachable by
   * scrolling, whereas 'safe' falls back to the top and prints the lot. */
  function centreCss(base) {
    return '.' + base + '{margin-left:auto;margin-right:auto}' +
      '@media print{html,body{height:100%}' +
      'body{display:flex;flex-direction:column;justify-content:safe center}}';
  }

  return {
    DEFAULT: DEFAULT,
  SHARE_DEFAULT: SHARE_DEFAULT,
    RECEIPT_DEFAULT: RECEIPT_DEFAULT,
    GAP_MM: GAP_MM,
    CUT_GAP_MM: CUT_GAP_MM,
    SIZES: SIZES,
    normalize: normalize,
    label: label,
    pageCss: pageCss,
    pageHeightMm: pageHeightMm,
    billWidthMm: billWidthMm,
    layoutCss: layoutCss
  };
})();

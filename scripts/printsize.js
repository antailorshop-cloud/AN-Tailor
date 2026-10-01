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
   * zeroed by the caller, so the two cannot stack into a double margin. */
  function pageCss(value) {
    var key = normalize(value);
    if (key === 'A5') return '@page{size:A5 portrait;margin:8mm}';
    if (key === 'A4HALF') return '@page{size:A4 landscape;margin:8mm}';
    return '@page{size:A4 portrait;margin:10mm}';
  }

  /* How tall the printable area of each sheet is, in millimetres: the paper height
   * less the margin pageCss() just set. This is what the auto-fit on the bill
   * measures itself against, so a bill with four garments and one with nine are
   * both told the same target.
   *
   *   A4      297mm paper, 10mm margins  -> 277mm
   *   A5      210mm paper, 8mm margins   -> 194mm
   *   A4HALF  A4 turned sideways, 8mm    -> 194mm, same as A5
   *
   * It is exported rather than kept private so the bill can ask for it and the
   * harness can check the arithmetic, which is the kind of number that is easy to
   * get subtly wrong and hard to see on paper. */
  function pageHeightMm(value) {
    var key = normalize(value);
    if (key === 'A5') return 194;
    if (key === 'A4HALF') return 194;
    return 277;
  }

  /* How wide the bill is laid out, in millimetres. The auto-fit on the bill sets
   * the measuring window to this before it measures anything, because a bill
   * measured on a wide screen wraps its garment names differently than the same
   * bill on a 190mm sheet - so without it the fit would be calculated against a
   * layout the printer never uses.
   *
   *   A4      210mm paper, 10mm margins -> 190mm
   *   A5      210mm paper, 8mm margins  -> 194mm, but the bill is capped at 132
   *   A4HALF  the left half of a landscape A4 -> 140mm
   *
   * These are the same numbers layoutCss() puts in the stylesheet, kept here as
   * values so a change to the layout and a change to the measurement cannot drift
   * apart unnoticed. */
  function billWidthMm(value) {
    var key = normalize(value);
    if (key === 'A5') return 194;
    if (key === 'A4HALF') return 140;
    return 190;
  }

  /* The layout rule for the printed body, given its own class so nothing else on
   * the page is narrowed by a print size. The class defaults to the bill's, so
   * bills.js is unaffected, and a receipt passes its own. */
  function layoutCss(value, className) {
    var key = normalize(value);
    var base = className || 'bill';

    if (key === 'A4HALF') {
      return '.' + base + '-half{width:140mm;min-height:194mm;' +
        'border-right:1px dashed #999;padding-right:6mm}';
    }

    if (key === 'A5') return '.' + base + '{width:194mm;max-width:194mm}';
    return '.' + base + '{width:190mm;max-width:190mm}';
  }

  return {
    DEFAULT: DEFAULT,
    RECEIPT_DEFAULT: RECEIPT_DEFAULT,
    SIZES: SIZES,
    normalize: normalize,
    label: label,
    pageCss: pageCss,
    pageHeightMm: pageHeightMm,
    billWidthMm: billWidthMm,
    layoutCss: layoutCss
  };
})();

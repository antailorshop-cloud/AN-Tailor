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

  /* The layout rule for the printed body, given its own class so nothing else on
   * the page is narrowed by a print size. The class defaults to the bill's, so
   * bills.js is unaffected, and a receipt passes its own. */
  function layoutCss(value, className) {
    var key = normalize(value);
    var base = className || 'bill';

    // Half of a landscape A4's printable width (281mm / 2 = 140.5mm), so the
    // dashed cut line lands on the true centre of the sheet.
    if (key === 'A4HALF') {
      return '.' + base + '-half{width:140mm;min-height:194mm;' +
        'border-right:1px dashed #999;padding-right:6mm}';
    }

    // A5 and A4 both print at their natural width; A5 is the narrower sheet, so
    // the body is capped to keep it off the edges.
    if (key === 'A5') return '.' + base + '{max-width:132mm}';
    return '.' + base + '{max-width:190mm}';
  }

  return {
    DEFAULT: DEFAULT,
    RECEIPT_DEFAULT: RECEIPT_DEFAULT,
    SIZES: SIZES,
    normalize: normalize,
    label: label,
    pageCss: pageCss,
    layoutCss: layoutCss
  };
})();

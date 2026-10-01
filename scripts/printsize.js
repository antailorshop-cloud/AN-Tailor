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

  // Ordered as they are offered in Settings, smallest sheet last because that
  // is the one a shop picks when it has thought about paper.
  var SIZES = [
    { key: 'A4', label: 'A4 - Full page' },
    { key: 'A5', label: 'A5 - Full A5 sheet' },
    { key: 'A4HALF', label: 'A4 sheet - A5 bill on the left (cut & reuse)' }
  ];

  /* Understands the spellings the legacy sheet may already hold, so a stored
   * value from the old system is never read as an unknown size. Anything
   * unrecognised falls back to A4 rather than printing at some guessed size. */
  function normalize(value) {
    var key = String(value == null ? '' : value)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (key === 'A5' || key === 'HALFA4' || key === 'A4A5') return 'A5';
    if (key === 'A4HALF' || key === 'HALF' || key === 'A4SHEET' || key === 'SHEET') return 'A4HALF';
    return DEFAULT;
  }

  function label(value) {
    var key = normalize(value);
    for (var i = 0; i < SIZES.length; i++) {
      if (SIZES[i].key === key) return SIZES[i].label;
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

  /* The layout rule for the bill body, given its own class so nothing else on
   * the page is narrowed by a print size. */
  function layoutCss(value) {
    var key = normalize(value);

    // Half of a landscape A4's printable width (281mm / 2 = 140.5mm), so the
    // dashed cut line lands on the true centre of the sheet.
    if (key === 'A4HALF') {
      return '.bill-half{width:140mm;min-height:194mm;' +
        'border-right:1px dashed #999;padding-right:6mm}';
    }

    // A5 and A4 both print the bill at its natural width; A5 is the narrower
    // sheet, so the table is capped to keep it off the edges.
    if (key === 'A5') return '.bill{max-width:132mm}';
    return '.bill{max-width:190mm}';
  }

  return {
    DEFAULT: DEFAULT,
    SIZES: SIZES,
    normalize: normalize,
    label: label,
    pageCss: pageCss,
    layoutCss: layoutCss
  };
})();

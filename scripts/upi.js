/* AN TAILOR - UPI payment links and UPI id rules.
 *
 * The address a customer's money lands in is decided by the UPI id, and a bill
 * with a wrong id still looks completely normal, so the id is cleaned and
 * checked here rather than trusted from the form. This is the same rule the
 * legacy system used.
 *
 *   vpa   = something@bank, letters and digits with . _ - allowed either side
 *   link  = a upi:// deep link that a phone hands straight to a UPI app
 *
 * link() builds the intent only when a real amount is owed and a valid id is
 * configured, so a settled bill never carries a code inviting a second payment.
 */

window.ANT = window.ANT || {};

window.ANT.upi = (function () {
  /* One @, a leading letter or digit on each side, no spaces. This is what a
   * bank will accept, and it is deliberately strict: a typo here sends money to
   * the wrong account. */
  var VPA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}@[A-Za-z][A-Za-z0-9._-]{1,63}$/;

  /* Trims the value and drops a leading "upi:" prefix, so a pasted link such as
   * "upi:antailor@okhdfcbank" is accepted as the id inside it. */
  function normalizeVpa(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^upi:\s*/i, '')
      .trim();
  }

  function isValidVpa(value) {
    return VPA_PATTERN.test(normalizeVpa(value));
  }

  /* Explains what is wrong, so the message in Settings says something more
   * useful than "invalid". Empty means the id is fine. */
  function vpaProblem(value) {
    var vpa = normalizeVpa(value);

    if (!vpa) return '';

    if (vpa.indexOf('@') === -1) {
      return 'A UPI ID needs an @, like antailor@okhdfcbank';
    }

    if (vpa.indexOf('@') !== vpa.lastIndexOf('@')) {
      return 'A UPI ID can only have one @';
    }

    if (!VPA_PATTERN.test(vpa)) {
      return 'That UPI ID has letters or symbols a bank will not accept. ' +
        'Use the one your UPI app shows, like antailor@okhdfcbank';
    }

    return '';
  }

  /* What the customer still owes, rounded to the paisa. Money is collected in
   * paise, so anything left below one paisa counts as nothing due - otherwise a
   * stray float remainder would print a QR asking for zero rupees on an
   * already settled bill. */
  function balanceDue(bill) {
    var due = Math.round((Number(bill && bill.balance) || 0) * 100) / 100;
    return due > 0 ? due : 0;
  }

  /* The payee name rides along in the link, so it is kept to what a bank
   * accepts. A blank name falls back to Merchant rather than an empty field. */
  function cleanPayee(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/[^A-Za-z0-9 ]+/g, '')
      .slice(0, 50) || 'Merchant';
  }

  /* The upi:// intent. Returns '' when there is nothing to pay or no usable id,
   * so callers can treat '' as "no QR on this bill". */
  function link(opts) {
    var o = opts || {};
    var vpa = normalizeVpa(o.vpa);
    var due = Math.round((Number(o.amount) || 0) * 100) / 100;

    if (!vpa || !VPA_PATTERN.test(vpa) || due <= 0) return '';

    // The '@' in the id is left literal on purpose. Several UPI apps mis-read a
    // percent-encoded id ("name%40bank" arrives as "name 40bank") and then
    // refuse the payee, so the raw id is what every app parses correctly.
    var parts = [
      'pa=' + vpa,
      'pn=' + encodeURIComponent(cleanPayee(o.payee)),
      'cu=INR'
    ];

    parts.push('am=' + due.toFixed(2));

    var note = String(o.note == null ? '' : o.note).slice(0, 40);
    parts.push('tn=' + encodeURIComponent(note));

    return 'upi://pay?' + parts.join('&');
  }

  /* The address of the little pay page, carrying the payee and amount. The
   * customer taps this https link in the WhatsApp message - WhatsApp makes an
   * https link tappable but ignores a upi:// one, and it also ignores a link
   * drawn inside the bill PDF, which is why a tap there did nothing. The page it
   * opens hands off to the phone's UPI app.
   *
   * '' when there is nothing to pay, no usable id, or the app is not served from
   * a real site: a file:// page has no address a customer's phone could open. */
  function pageLink(opts) {
    var o = opts || {};
    var vpa = normalizeVpa(o.vpa);
    var due = Math.round((Number(o.amount) || 0) * 100) / 100;

    if (!vpa || !VPA_PATTERN.test(vpa) || due <= 0) return '';

    // The page address is taken from the address bar so the link lands on
    // whatever copy of the app the shop runs. A base may be given instead, which
    // is how the tests exercise this with no real address bar.
    var base = String(o.base == null ? '' : o.base).trim();
    if (!base) {
      if (typeof window === 'undefined' || !window.location) return '';
      if (!/^https?:$/i.test(window.location.protocol)) return '';
      base = window.location.href;
    }

    var url;
    try {
      url = new URL('pay.html', base);
    } catch (e) {
      return '';
    }

    url.search = '';
    url.hash = '';

    var query = 'pa=' + encodeURIComponent(vpa) +
      '&pn=' + encodeURIComponent(cleanPayee(o.payee)) +
      '&am=' + encodeURIComponent(due.toFixed(2));

    var note = String(o.note == null ? '' : o.note).slice(0, 40);
    if (note) query += '&tn=' + encodeURIComponent(note);

    return url.toString() + '?' + query;
  }

  return {
    normalizeVpa: normalizeVpa,
    isValidVpa: isValidVpa,
    vpaProblem: vpaProblem,
    cleanPayee: cleanPayee,
    balanceDue: balanceDue,
    link: link,
    pageLink: pageLink
  };
})();

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

    var parts = [
      'pa=' + encodeURIComponent(vpa),
      'pn=' + encodeURIComponent(cleanPayee(o.payee)),
      'cu=INR'
    ];

    parts.push('am=' + due.toFixed(2));

    var note = String(o.note == null ? '' : o.note).slice(0, 40);
    parts.push('tn=' + encodeURIComponent(note));

    return 'upi://pay?' + parts.join('&');
  }

  return {
    normalizeVpa: normalizeVpa,
    isValidVpa: isValidVpa,
    vpaProblem: vpaProblem,
    cleanPayee: cleanPayee,
    balanceDue: balanceDue,
    link: link
  };
})();

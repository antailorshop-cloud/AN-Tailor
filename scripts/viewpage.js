/* AN TAILOR - the bill landing page's handoff.
 *
 * A web link cannot choose which app opens it: the phone hands an https link to
 * the browser, and the browser's own PDF viewer ignores the pay link drawn on
 * the page, so a tap on "Tap to Pay" does nothing there. The only way to reach a
 * real PDF app - Drive, Files, a reader - is the Android "intent" handoff, which
 * asks the system to open the file and lets it choose the app. On anything that
 * is not Android there is no handoff and the bill is shown in the browser, as
 * before.
 */

window.ANT = window.ANT || {};

window.ANT.viewpage = (function () {
  function isAndroid(ua) {
    return /Android/i.test(String(ua == null ? '' : ua));
  }

  /* The intent that opens the bill with whatever the phone uses for a PDF. The
   * MIME type is what pulls a reader into the choice rather than only the
   * browser; the fallback URL is where the phone goes if nothing can handle it,
   * so a device with no reader still reaches the bill.
   *
   * '' for anything that is not an http(s) address, so a caller can treat '' as
   * "no handoff" rather than navigating a browser to a broken address. */
  function intent(url) {
    var u = String(url == null ? '' : url);
    if (!/^https?:\/\//i.test(u)) return '';

    var scheme = u.slice(0, 5).toLowerCase() === 'https' ? 'https' : 'http';
    var data = u.replace(/^https?:\/\//i, '');

    return 'intent://' + data + '#Intent;scheme=' + scheme +
      ';action=android.intent.action.VIEW;type=application/pdf;' +
      'S.browser_fallback_url=' + encodeURIComponent(u) + ';end';
  }

  return {
    isAndroid: isAndroid,
    intent: intent
  };
})();

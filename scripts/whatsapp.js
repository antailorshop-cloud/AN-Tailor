/* AN TAILOR - WhatsApp messages.
 *
 * There are three moments the shop wants to speak to a customer: sending the
 * bill, chasing a balance that is still due, and saying an order is ready to
 * collect. Each is built here from the record itself rather than typed out,
 * so every customer gets the same wording, the same figures and the same shop
 * name, and the tailor never has to read a total off one screen and retype it
 * into another. A retyped number is a number that can disagree with the bill.
 *
 * There is deliberately no link into the app in any message. A public bill
 * page would publish a customer's name and what they owe to anyone who held
 * the link, and the shop decided that cost was not worth paying. The messages
 * carry the figures themselves, which is the whole of what is being said.
 *
 * Each wording lives in shop_settings - wa_bill_message, wa_reminder_message,
 * wa_ready_message - so the owner can say it in their own voice. An empty or
 * missing row falls back to the default for that message, so a fresh shop
 * still sends a complete message and a cleared box never sends a half one.
 */

window.ANT = window.ANT || {};

window.ANT.whatsapp = (function () {
  var money = function (v) { return window.ANT.money(v); };

  /* The message a bill sends when the owner has not written their own. It uses
   * only tokens that are always available, so it can never come out with a
   * blank where a number should be. */
  var DEFAULT_BILL =
    'Hello {customer}, greetings from {shop}!\n\n' +
    'Your bill for the following orders is ready.\n\n' +
    'Bill No: {billNo}\n' +
    'Orders: {orders}\n' +
    'Total Amount: {amount}\n' +
    'Paid: {paid}\n' +
    'Balance Due: {balance}\n' +
    'Delivery Date: {delivery}\n\n' +
    'Thank you for choosing {shop}.';

  /* Sent when a balance is still outstanding. It names the delivery date and
   * the amount so the customer can place the reminder against a real order. */
  var DEFAULT_REMINDER =
    'Hello {customer}, gentle reminder from {shop}.\n\n' +
    'Your order {orders} is due for delivery on {delivery}.\n' +
    'Total: {amount}\n\n' +
    '{balanceBlock}\n\n' +
    'Thank you,\n{shop}';

  /* Sent when an order is ready. balanceBlock is used rather than the balance
   * token on its own, so an order already paid for is told it is paid in full
   * instead of being asked for money it does not owe. */
  var DEFAULT_READY =
    'Hello {customer}, good news from {shop}!\n\n' +
    'Your order {orders} is ready.\n' +
    'Delivery Date: {delivery}\n\n' +
    '{balanceBlock}\n\n' +
    'Please collect it from our shop.\n\n' +
    'Thank you for choosing {shop}.';

  /* What the owner may type into the template, and what the reader sees it as.
   * Kept in one place so the legend in Settings cannot drift from the
   * replacement in fill(). */
  var TOKENS = [
    ['{shop}', 'Shop name'],
    ['{customer}', 'Customer name'],
    ['{billNo}', 'Bill number'],
    ['{orders}', 'Order numbers on the bill'],
    ['{amount}', 'Bill amount'],
    ['{paid}', 'Already paid'],
    ['{balance}', 'Balance still due'],
    ['{balanceBlock}', 'A whole sentence for the balance'],
    ['{delivery}', 'Delivery date']
  ];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* A delivery date written the way a tailor says it - "20 Sep 2026" - rather
   * than the raw ISO string. Built from the parts instead of toLocaleDateString
   * so the same shop gets the same text on every phone. */
  function dateText(iso) {
    var s = String(iso == null ? '' : iso).slice(0, 10);
    var parts = s.split('-');
    if (parts.length !== 3 || parts[0] === '') return '';
    return parts[2] + ' ' + (MONTHS[Number(parts[1]) - 1] || parts[1]) + ' ' + parts[0];
  }

  /* An Indian phone number reduced to the digits wa.me wants: country code and
   * number, no plus, no spaces.
   *
   * A number is stored by the shop in any of the shapes a customer writes it -
   * 9800000000, +91 98000 00000, 098000 00000 - and all three are the same
   * phone. Only a number that reduces to a real 10-digit mobile is accepted;
   * anything else is refused rather than guessed at, because a message sent to
   * a wrongly assembled number goes to a stranger. */
  function normalizeMobile(mobile) {
    var digits = String(mobile == null ? '' : mobile).replace(/\D/g, '');

    var number = '';
    if (digits.length === 12 && digits.slice(0, 2) === '91') number = digits;
    else if (digits.length === 11 && digits.charAt(0) === '0') number = '91' + digits.slice(1);
    else if (digits.length === 10) number = '91' + digits;

    return number ? { ok: true, number: number } : { ok: false, number: '' };
  }

  // Whether there is a phone to send to at all, which is how the Bills page
  // knows to draw the button. Separate from the check inside link() so a row
  // does not offer an action that will only apologise.
  function canSend(mobile) {
    return normalizeMobile(mobile).ok;
  }

  function template(raw, fallback) {
    return String(raw == null ? '' : raw).trim() || fallback || DEFAULT_BILL;
  }

  /* The plain text for the balance, as a whole sentence rather than a number
   * on its own. A reminder for a bill that is already settled must not read
   * "Balance Due: Rs 0.00" and then ask for it. */
  function balanceBlock(due) {
    if (!(due > 0)) {
      return 'Balance: Paid in full. No payment pending.';
    }
    return 'Balance Due: ' + money(due) +
      '\n\nPlease pay the balance at the time of delivery.';
  }

  /* The latest delivery date across the bill's orders, because a bill is not
   * finished until its last order is, and a customer waiting on several
   * garments wants the date the whole lot is ready. */
  function deliveryText(orders) {
    var best = '';
    (orders || []).forEach(function (o) {
      var s = String((o && o.delivery_date) || '').slice(0, 10);
      if (s && s > best) best = s;
    });
    return dateText(best) || '-';
  }

  /* The values the placeholders stand for. Every one has a fallback, so a token
   * left in a custom template can never come out empty in front of a customer. */
  function billTokens(opts) {
    var o = opts || {};
    var shop = o.shop || {};
    var customer = o.customer || {};
    var bill = o.bill || {};
    var orders = o.orders || [];

    var due = window.ANT.upi
      ? window.ANT.upi.balanceDue(bill)
      : Math.max(0, num(bill.balance));

    var codes = orders.map(function (order) { return order && order.code; })
      .filter(Boolean);

    return {
      shop: String(shop.name || 'AN TAILOR'),
      customer: String(customer.name || 'Customer'),
      billNo: String(bill.code || ''),
      orders: codes.length ? codes.join(', ') : '-',
      amount: money(bill.bill_amount),
      paid: money(bill.advance),
      balance: money(due),
      due: money(due),
      balanceBlock: balanceBlock(due),
      delivery: deliveryText(orders)
    };
  }

  /* The values for a single order, used by the ready message. There is no bill
   * number here on purpose: an order can be ready before it is billed, and a
   * "Bill No:" line with nothing after it is worse than no line at all. A
   * template that asks for {billNo} anyway gets it scrubbed. */
  function orderTokens(opts) {
    var o = opts || {};
    var shop = o.shop || {};
    var customer = o.customer || {};
    var order = o.order || {};

    var due = Math.max(0, num(order.balance));

    return {
      shop: String(shop.name || 'AN TAILOR'),
      customer: String(customer.name || 'Customer'),
      billNo: '',
      orders: String(order.code || '-'),
      amount: money(order.total),
      paid: money(order.advance),
      balance: money(due),
      due: money(due),
      balanceBlock: balanceBlock(due),
      delivery: dateText(order.delivery_date) || '-'
    };
  }

  /* The one place replacements happen.
   *
   * A placeholder typed with spaces inside it - "{ billLink }" - is the same
   * placeholder as "{billLink}". Without the first rule it would miss every
   * replacement below and then miss the scrub too, and the customer would
   * receive the braces as plain text. Anything still in braces afterwards is a
   * token this build does not know - a retired one, or a typo - and is removed
   * rather than shown, so a customer never reads "{billLink}" as literal text. */
  function fill(tpl, tokens) {
    var t = tokens || {};

    // A plain value is inserted with a function, not a string, so a "$" in a
    // customer's name or a custom template is copied through rather than read
    // as a replacement pattern.
    var put = function (text) {
      return function () { return text || ''; };
    };

    return String(tpl == null ? '' : tpl)
      .replace(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}/g, '{$1}')
      .replace(/\{shop\}/g, put(t.shop))
      .replace(/\{customer\}/g, put(t.customer))
      .replace(/\{billNo\}/g, put(t.billNo))
      .replace(/\{orders\}/g, put(t.orders))
      .replace(/\{items\}/g, '')
      .replace(/\{amount\}/g, put(t.amount))
      .replace(/\{paid\}/g, put(t.paid))
      .replace(/\{balance\}/g, put(t.balance))
      .replace(/\{due\}/g, put(t.due))
      .replace(/\{balanceBlock\}/g, put(t.balanceBlock))
      .replace(/\{delivery\}/g, put(t.delivery))
      // The scrub, after the known tokens are gone. Dropping a placeholder
      // leaves the spaces and the blank line that sat around it, so the
      // leftovers are tidied rather than sent.
      .replace(/\{[^}]*\}/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function billMessage(opts) {
    var o = opts || {};
    var shop = o.shop || {};
    return fill(template(shop.waBillMessage, DEFAULT_BILL), billTokens(o));
  }

  /* A bill the customer has not paid yet. Reads from the same bill record the
   * bill message does, so the two can never disagree on the balance. */
  function reminderMessage(opts) {
    var o = opts || {};
    var shop = o.shop || {};
    return fill(template(shop.waReminderMessage, DEFAULT_REMINDER), billTokens(o));
  }

  /* An order that is ready to collect. Built from the order, not a bill, because
   * an order can be ready long before anyone has billed it. */
  function readyMessage(opts) {
    var o = opts || {};
    var shop = o.shop || {};
    return fill(template(shop.waReadyMessage, DEFAULT_READY), orderTokens(o));
  }

  /* The wa.me link. Returns '' when there is no usable number, so a caller can
   * treat '' as "do not offer WhatsApp" rather than opening a broken chat. */
  function link(mobile, message) {
    var m = normalizeMobile(mobile);
    if (!m.ok) return '';
    return 'https://wa.me/' + m.number + '?text=' + encodeURIComponent(String(message == null ? '' : message));
  }

  return {
    DEFAULT_BILL: DEFAULT_BILL,
    DEFAULT_REMINDER: DEFAULT_REMINDER,
    DEFAULT_READY: DEFAULT_READY,
    TOKENS: TOKENS,
    normalizeMobile: normalizeMobile,
    canSend: canSend,
    template: template,
    fill: fill,
    billTokens: billTokens,
    orderTokens: orderTokens,
    billMessage: billMessage,
    reminderMessage: reminderMessage,
    readyMessage: readyMessage,
    link: link
  };
})();

const { paiseToRupees, rupeesToPaise } = require('./money');

/**
 * UPI deep-link strings (`upi://pay?pa=...`) — the same format real UPI QR
 * codes use, so a scanner-shaped client can consume these directly.
 *
 * Pure string handling, no DB, so it's unit-testable.
 */
const buildUpiUri = ({ upiId, name, amountPaise, note }) => {
  if (!upiId) throw new Error('upiId is required to build a UPI URI');

  const params = new URLSearchParams();
  params.set('pa', upiId); // payee address
  if (name) params.set('pn', name); // payee name
  if (amountPaise) params.set('am', paiseToRupees(amountPaise).toFixed(2));
  params.set('cu', 'INR');
  if (note) params.set('tn', note); // transaction note

  return `upi://pay?${params.toString()}`;
};

const parseUpiUri = (uri) => {
  const raw = String(uri).trim();

  // Accept a bare UPI ID as well as a full deep link
  if (!raw.toLowerCase().startsWith('upi://')) {
    if (/^[\w.\-]+@[\w.\-]+$/.test(raw)) return { upiId: raw };
    throw new Error('Not a valid UPI QR code or UPI ID');
  }

  const query = raw.slice(raw.indexOf('?') + 1);
  const params = new URLSearchParams(query);
  const upiId = params.get('pa');

  if (!upiId) throw new Error("UPI QR code is missing the payee address ('pa')");

  const amount = params.get('am');

  return {
    upiId,
    name: params.get('pn') || undefined,
    amountPaise: amount ? rupeesToPaise(amount) : undefined,
    note: params.get('tn') || undefined,
  };
};

module.exports = { buildUpiUri, parseUpiUri };

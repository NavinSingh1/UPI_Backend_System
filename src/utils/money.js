/**
 * Money handling.
 *
 * Everything persisted in MongoDB is an INTEGER NUMBER OF PAISE. Never store
 * rupees as a float: `amount: Number` in BSON is an IEEE-754 double, so
 * 0.1 + 0.2 === 0.30000000000000004 and those errors accumulate once you
 * start summing hundreds of transactions.
 *
 * The API boundary still speaks rupees (so existing clients keep working) —
 * convert on the way in with rupeesToPaise() and on the way out with
 * paiseToRupees(). All arithmetic in between is integer arithmetic.
 */

// Matches an optionally-negative decimal with at most 2 decimal places.
const RUPEE_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Largest amount we're willing to represent (₹10 crore in paise) — guards against overflow-ish nonsense. */
const MAX_PAISE = 100000000000;

/**
 * Converts a rupee amount (number or string) to integer paise WITHOUT
 * floating-point multiplication. `Math.round(rupees * 100)` is subtly wrong
 * for some values, so we parse the decimal string instead.
 */
const rupeesToPaise = (rupees) => {
  if (rupees === null || rupees === undefined || rupees === '') {
    throw new Error('Amount is required');
  }

  const raw = typeof rupees === 'string' ? rupees.trim() : String(rupees);

  if (!RUPEE_PATTERN.test(raw)) {
    throw new Error('Amount must be a number with at most 2 decimal places (e.g. 149.50)');
  }

  const isNegative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');

  // padEnd handles "12.5" -> 50 paise, not 5
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (paise > MAX_PAISE) {
    throw new Error('Amount exceeds the maximum supported value');
  }

  return isNegative ? -paise : paise;
};

/** Converts integer paise back to a rupee number with exactly 2 decimal places. */
const paiseToRupees = (paise) => {
  const int = Math.trunc(paise);
  return Number((int / 100).toFixed(2));
};

/** Human-readable rupee string, e.g. 149550 -> "₹1,495.50" */
const formatPaise = (paise) => {
  const rupees = paiseToRupees(paise);
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * Splits a total into `count` shares that sum EXACTLY to the total.
 * Integer division leaves a remainder (₹100 across 3 people = 3333.33…),
 * so the leftover paise are distributed one each to the earliest shares
 * rather than silently lost or double-counted.
 */
const splitPaise = (totalPaise, count) => {
  if (!Number.isInteger(totalPaise) || totalPaise <= 0) {
    throw new Error('Total must be a positive integer number of paise');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Share count must be a positive integer');
  }

  const base = Math.floor(totalPaise / count);
  let remainder = totalPaise - base * count;

  return Array.from({ length: count }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return base + extra;
  });
};

module.exports = { rupeesToPaise, paiseToRupees, formatPaise, splitPaise, MAX_PAISE };

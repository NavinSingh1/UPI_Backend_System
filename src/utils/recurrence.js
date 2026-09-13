/**
 * Pure date maths for recurring payments — no DB, so it's unit-testable.
 */

/** Stable per-period identifier used for idempotency (YYYY-MM-DD, UTC-safe). */
const periodKey = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Next run date after `from` for a given frequency.
 *
 * MONTHLY clamps to the last day of the target month, so a mandate created
 * on the 31st doesn't skip February — Date would otherwise roll "Feb 31"
 * forward into March.
 */
const nextRunDate = (from, frequency) => {
  const base = new Date(from);

  switch (frequency) {
    case 'DAILY': {
      const next = new Date(base);
      next.setDate(next.getDate() + 1);
      return next;
    }
    case 'WEEKLY': {
      const next = new Date(base);
      next.setDate(next.getDate() + 7);
      return next;
    }
    case 'MONTHLY': {
      const targetMonth = base.getMonth() + 1;
      const year = base.getFullYear() + Math.floor(targetMonth / 12);
      const month = targetMonth % 12;
      const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
      const day = Math.min(base.getDate(), daysInTargetMonth);
      return new Date(year, month, day, base.getHours(), base.getMinutes(), 0, 0);
    }
    default:
      throw new Error(`Unknown frequency: ${frequency}`);
  }
};

module.exports = { periodKey, nextRunDate };

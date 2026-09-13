const { rupeesToPaise } = require('../utils/money');

/**
 * Transaction limits, modelled on real UPI caps. All values are read from
 * env (in rupees, for readability) and converted to paise once at startup.
 */
const fromEnvRupees = (key, fallbackRupees) => rupeesToPaise(process.env[key] || String(fallbackRupees));

module.exports = {
  // Largest single outbound transaction
  perTransactionPaise: fromEnvRupees('LIMIT_PER_TRANSACTION', 100000), // ₹1,00,000
  // Rolling calendar-day outbound total
  dailyPaise: fromEnvRupees('LIMIT_DAILY', 100000), // ₹1,00,000
  // Calendar-month outbound total
  monthlyPaise: fromEnvRupees('LIMIT_MONTHLY', 1000000), // ₹10,00,000
  // Velocity: max number of outbound transactions per day
  dailyCount: Number(process.env.LIMIT_DAILY_COUNT || 20),
  // Pagination hard cap so ?limit=999999 can't dump a collection
  maxPageSize: Number(process.env.MAX_PAGE_SIZE || 100),
  // MPIN lockout
  mpinMaxAttempts: Number(process.env.MPIN_MAX_ATTEMPTS || 5),
  mpinLockSeconds: Number(process.env.MPIN_LOCK_SECONDS || 15 * 60),
};

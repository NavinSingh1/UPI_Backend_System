const { getCache, setCache, deleteCache } = require('./cache');
const { mpinMaxAttempts, mpinLockSeconds } = require('../config/limits');

/**
 * Account-level MPIN lockout.
 *
 * The rate limiter on /setup-mpin is per-IP, which does NOT protect an
 * account: an attacker rotating IPs can still walk all 10,000 four-digit
 * MPINs. This counter is keyed by user id instead, so failures follow the
 * account no matter where they come from.
 */
const failKey = (userId) => `mpin:fails:${userId}`;
const lockKey = (userId) => `mpin:locked:${userId}`;

/** Seconds remaining on an active lock, or 0 if not locked. */
const getLockRemaining = async (userId) => {
  const lockedUntil = await getCache(lockKey(userId));
  if (!lockedUntil) return 0;

  const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
  if (remaining <= 0) {
    await deleteCache(lockKey(userId));
    return 0;
  }
  return remaining;
};

/**
 * Records a failed attempt. Returns { locked, attemptsLeft, lockSeconds }
 * so the caller can tell the user how many tries remain.
 */
const recordFailure = async (userId) => {
  const attempts = ((await getCache(failKey(userId))) || 0) + 1;
  await setCache(failKey(userId), attempts, mpinLockSeconds);

  if (attempts >= mpinMaxAttempts) {
    await setCache(lockKey(userId), Date.now() + mpinLockSeconds * 1000, mpinLockSeconds);
    await deleteCache(failKey(userId));
    return { locked: true, attemptsLeft: 0, lockSeconds: mpinLockSeconds };
  }

  return { locked: false, attemptsLeft: mpinMaxAttempts - attempts, lockSeconds: 0 };
};

/** Clears the counter after a correct MPIN (or an MPIN reset). */
const clearFailures = async (userId) => {
  await Promise.all([deleteCache(failKey(userId)), deleteCache(lockKey(userId))]);
};

module.exports = { getLockRemaining, recordFailure, clearFailures };

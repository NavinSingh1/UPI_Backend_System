const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const { getLockRemaining, recordFailure, clearFailures } = require('../utils/mpinLockout');

/**
 * Verifies req.body.mpin against the logged-in user's stored hash, with
 * account-level lockout after repeated failures.
 *
 * Must run AFTER `protect` (needs req.user, which carries the mpin hash)
 * and AFTER body validation (needs req.body.mpin present).
 */
const verifyMpin = asyncHandler(async (req, res, next) => {
  const { mpin } = req.body;
  const userId = req.user._id;

  if (!req.user.mpin) {
    return res.status(400).json({ message: 'Please setup your MPIN first' });
  }

  const lockRemaining = await getLockRemaining(userId);
  if (lockRemaining > 0) {
    return res.status(429).json({
      message: `Too many incorrect MPIN attempts. Try again in ${Math.ceil(lockRemaining / 60)} minute(s).`,
      retryAfterSeconds: lockRemaining,
    });
  }

  const isMpinCorrect = await bcrypt.compare(mpin.toString(), req.user.mpin);

  if (!isMpinCorrect) {
    const { locked, attemptsLeft, lockSeconds } = await recordFailure(userId);

    if (locked) {
      return res.status(429).json({
        message: `Incorrect MPIN. Account locked for ${Math.ceil(lockSeconds / 60)} minute(s).`,
        retryAfterSeconds: lockSeconds,
      });
    }

    return res.status(401).json({
      message: 'Incorrect MPIN',
      attemptsLeft,
    });
  }

  await clearFailures(userId);
  next();
});

module.exports = verifyMpin;

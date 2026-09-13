const Transaction = require('../models/Transaction');
const asyncHandler = require('../utils/asyncHandler');
const { rupeesToPaise, paiseToRupees, formatPaise } = require('../utils/money');
const limits = require('../config/limits');

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const startOfThisMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

/** Sums the user's successful OUTBOUND paise since `since`, plus the count. */
const outboundSince = async (userId, since) => {
  const [row] = await Transaction.aggregate([
    {
      $match: {
        sender: userId,
        status: 'SUCCESS',
        type: { $in: ['TRANSFER', 'WITHDRAW', 'BILL_PAY'] },
        createdAt: { $gte: since },
      },
    },
    { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
  ]);

  return { totalPaise: row?.totalPaise || 0, count: row?.count || 0 };
};

/**
 * Enforces UPI-style spending caps before a debit is attempted: per
 * transaction, per calendar day, per calendar month, and a daily
 * transaction-count velocity check. Configure via LIMIT_* env vars.
 *
 * Runs AFTER validation (needs req.body.amount) and AFTER `protect`.
 */
const enforceTransactionLimits = asyncHandler(async (req, res, next) => {
  const amountPaise = rupeesToPaise(req.body.amount);
  const userId = req.user._id;

  if (amountPaise > limits.perTransactionPaise) {
    return res.status(400).json({
      message: `Amount exceeds the per-transaction limit of ${formatPaise(limits.perTransactionPaise)}`,
      limit: paiseToRupees(limits.perTransactionPaise),
    });
  }

  const [today, month] = await Promise.all([
    outboundSince(userId, startOfToday()),
    outboundSince(userId, startOfThisMonth()),
  ]);

  if (today.count + 1 > limits.dailyCount) {
    return res.status(429).json({
      message: `Daily transaction limit of ${limits.dailyCount} reached. Try again tomorrow.`,
    });
  }

  if (today.totalPaise + amountPaise > limits.dailyPaise) {
    return res.status(400).json({
      message: `This would exceed your daily limit of ${formatPaise(limits.dailyPaise)}`,
      spentToday: paiseToRupees(today.totalPaise),
      remainingToday: paiseToRupees(Math.max(limits.dailyPaise - today.totalPaise, 0)),
    });
  }

  if (month.totalPaise + amountPaise > limits.monthlyPaise) {
    return res.status(400).json({
      message: `This would exceed your monthly limit of ${formatPaise(limits.monthlyPaise)}`,
      spentThisMonth: paiseToRupees(month.totalPaise),
      remainingThisMonth: paiseToRupees(Math.max(limits.monthlyPaise - month.totalPaise, 0)),
    });
  }

  // Hand the parsed integer downstream so controllers don't reparse
  req.amountPaise = amountPaise;
  next();
});

module.exports = { enforceTransactionLimits, outboundSince, startOfToday, startOfThisMonth };

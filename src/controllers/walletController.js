const User = require('../models/User');
const Transaction = require('../models/Transaction');
const asyncHandler = require('../utils/asyncHandler');
const { postTransaction, reconcileUser } = require('../services/ledgerService');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');
const { serializeTransaction } = require('../utils/serializers');
const { getCache, setCache } = require('../utils/cache');
const { outboundSince, startOfToday, startOfThisMonth } = require('../middlewares/enforceLimits');
const limits = require('../config/limits');

// @desc    Get current wallet balance (cached)
// @route   GET /api/wallet/balance
// @access  Private
const getBalance = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const cacheKey = `user:balance:${userId}`;

  const cached = await getCache(cacheKey);
  if (cached !== null) return res.json(cached);

  const user = await User.findById(userId).select('balancePaise');
  const payload = {
    balance: paiseToRupees(user.balancePaise),
    balancePaise: user.balancePaise,
  };

  await setCache(cacheKey, payload, 120);
  res.json(payload);
});

// @desc    Remaining spend headroom against the configured limits
// @route   GET /api/wallet/limits
// @access  Private
const getLimits = asyncHandler(async (req, res) => {
  const [today, month] = await Promise.all([
    outboundSince(req.user._id, startOfToday()),
    outboundSince(req.user._id, startOfThisMonth()),
  ]);

  res.json({
    perTransaction: paiseToRupees(limits.perTransactionPaise),
    daily: {
      limit: paiseToRupees(limits.dailyPaise),
      spent: paiseToRupees(today.totalPaise),
      remaining: paiseToRupees(Math.max(limits.dailyPaise - today.totalPaise, 0)),
      transactionsUsed: today.count,
      transactionsAllowed: limits.dailyCount,
    },
    monthly: {
      limit: paiseToRupees(limits.monthlyPaise),
      spent: paiseToRupees(month.totalPaise),
      remaining: paiseToRupees(Math.max(limits.monthlyPaise - month.totalPaise, 0)),
    },
  });
});

// @desc    Add mock money to wallet from linked bank
// @route   POST /api/wallet/add-money
// @access  Private
const addMoney = asyncHandler(async (req, res) => {
  const amountPaise = rupeesToPaise(req.body.amount);

  const { transaction, receiverBalanceAfter } = await postTransaction({
    type: 'ADD_MONEY',
    amountPaise,
    toUserId: req.user._id,
  });

  res.json({
    message: `Successfully added ${paiseToRupees(amountPaise)} to wallet`,
    balance: paiseToRupees(receiverBalanceAfter),
    transaction: serializeTransaction(transaction),
  });
});

// @desc    Pay Utility Bills (Recharge, Electricity)
// @route   POST /api/wallet/pay-bill
// @access  Private (MPIN verified + limits enforced by middleware)
const payBill = asyncHandler(async (req, res) => {
  const { billerName } = req.body;
  const amountPaise = req.amountPaise ?? rupeesToPaise(req.body.amount);

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'BILL_PAY',
    amountPaise,
    fromUserId: req.user._id,
    billerName,
  });

  res.json({
    message: `Bill paid successfully for ${billerName}`,
    balance: paiseToRupees(senderBalanceAfter),
    transaction: serializeTransaction(transaction),
  });
});

// @desc    Withdraw money from wallet to bank
// @route   POST /api/wallet/withdraw
// @access  Private (MPIN verified + limits enforced by middleware)
const withdraw = asyncHandler(async (req, res) => {
  const amountPaise = req.amountPaise ?? rupeesToPaise(req.body.amount);

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'WITHDRAW',
    amountPaise,
    fromUserId: req.user._id,
  });

  res.json({
    message: `${paiseToRupees(amountPaise)} withdrawn to your bank account`,
    balance: paiseToRupees(senderBalanceAfter),
    transaction: serializeTransaction(transaction),
  });
});

// @desc    Last 5 transactions
// @route   GET /api/wallet/mini-statement
// @access  Private
const miniStatement = asyncHandler(async (req, res) => {
  const transactions = await Transaction.find({ participants: req.user._id })
    .populate('sender', 'name upiId')
    .populate('receiver', 'name upiId')
    .sort({ createdAt: -1 })
    .limit(5);

  res.json(transactions.map(serializeTransaction));
});

// @desc    Verify the cached balance still matches the ledger
// @route   GET /api/wallet/reconcile
// @access  Private
const reconcile = asyncHandler(async (req, res) => {
  const report = await reconcileUser(req.user._id);

  res.json({
    ...report,
    cached: paiseToRupees(report.cachedPaise),
    derived: paiseToRupees(report.derivedPaise),
    drift: paiseToRupees(report.driftPaise),
    message: report.balanced
      ? 'Wallet balance matches the ledger exactly'
      : 'Balance does not match the ledger — this indicates a bug and should be investigated',
  });
});

module.exports = { getBalance, getLimits, addMoney, payBill, withdraw, miniStatement, reconcile };

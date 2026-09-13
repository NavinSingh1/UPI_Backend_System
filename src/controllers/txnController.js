const Transaction = require('../models/Transaction');
const User = require('../models/User');
const LedgerEntry = require('../models/LedgerEntry');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../config/limits');
const { postTransaction } = require('../services/ledgerService');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');
const { serializeTransaction, serializeLedgerEntry } = require('../utils/serializers');
const { getCache, setCache } = require('../utils/cache');
const { buildStatementCsv, buildStatementPdf } = require('../services/statementService');

/** Resolves a phone number or UPI ID to an active user. */
const findUserByIdentifier = async (identifier) =>
  User.findOne({
    $or: [{ phone: identifier }, { upiId: identifier }],
    isActive: { $ne: false },
  });

// @desc    Send money via Phone Number OR UPI ID
// @route   POST /api/transactions/send
// @access  Private (MPIN verified + limits enforced by middleware)
const sendMoney = asyncHandler(async (req, res) => {
  const { receiverIdentifier } = req.body;
  const amountPaise = req.amountPaise ?? rupeesToPaise(req.body.amount);

  const receiver = await findUserByIdentifier(receiverIdentifier);
  if (!receiver) {
    return res.status(404).json({ message: 'Receiver not found (Invalid Phone/UPI)' });
  }

  if (String(receiver._id) === String(req.user._id)) {
    return res.status(400).json({ message: 'You cannot send money to yourself' });
  }

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'TRANSFER',
    amountPaise,
    fromUserId: req.user._id,
    toUserId: receiver._id,
  });

  res.status(201).json({
    message: 'Money Transfer Successful',
    transaction: serializeTransaction(transaction),
    newBalance: paiseToRupees(senderBalanceAfter),
  });
});

// @desc    Paginated, filterable transaction history
// @route   GET /api/transactions/history?page=&limit=&type=&status=&category=&from=&to=
// @access  Private
const getTransactionHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page = 1, limit = 10, type, status, category, from, to } = req.query;

  // Single-index query on `participants` instead of the old $or scan
  const query = { participants: userId };
  if (type) query.type = type;
  if (status) query.status = status;
  if (category) query.category = category;
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) query.createdAt.$lte = new Date(to);
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  // Hard cap so ?limit=999999 can't dump the collection
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), limits.maxPageSize);

  const cacheKey = `user:txn:${userId}:${JSON.stringify({ pageNum, limitNum, type, status, category, from, to })}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      .populate('sender', 'name phone upiId')
      .populate('receiver', 'name phone upiId')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Transaction.countDocuments(query),
  ]);

  const payload = {
    transactions: transactions.map(serializeTransaction),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };

  await setCache(cacheKey, payload, 300);
  res.json(payload);
});

// @desc    Totals for the current calendar month
// @route   GET /api/transactions/summary
// @access  Private
const getTransactionSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const rows = await Transaction.aggregate([
    { $match: { participants: userId, status: 'SUCCESS', createdAt: { $gte: startOfMonth } } },
    {
      $group: {
        _id: { type: '$type', outbound: { $eq: ['$sender', userId] } },
        totalPaise: { $sum: '$amountPaise' },
        count: { $sum: 1 },
      },
    },
  ]);

  const summary = {
    totalSentPaise: 0,
    totalReceivedPaise: 0,
    totalBillsPaidPaise: 0,
    totalAddedMoneyPaise: 0,
    totalWithdrawnPaise: 0,
    transactionCount: 0,
  };

  rows.forEach(({ _id, totalPaise, count }) => {
    summary.transactionCount += count;
    const { type, outbound } = _id;
    if ((type === 'TRANSFER' || type === 'REFUND') && outbound) summary.totalSentPaise += totalPaise;
    else if (type === 'TRANSFER' || type === 'REFUND') summary.totalReceivedPaise += totalPaise;
    else if (type === 'BILL_PAY') summary.totalBillsPaidPaise += totalPaise;
    else if (type === 'ADD_MONEY') summary.totalAddedMoneyPaise += totalPaise;
    else if (type === 'WITHDRAW') summary.totalWithdrawnPaise += totalPaise;
  });

  res.json({
    month: startOfMonth.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
    transactionCount: summary.transactionCount,
    totalSent: paiseToRupees(summary.totalSentPaise),
    totalReceived: paiseToRupees(summary.totalReceivedPaise),
    totalBillsPaid: paiseToRupees(summary.totalBillsPaidPaise),
    totalAddedMoney: paiseToRupees(summary.totalAddedMoneyPaise),
    totalWithdrawn: paiseToRupees(summary.totalWithdrawnPaise),
    limits: {
      perTransaction: paiseToRupees(limits.perTransactionPaise),
      daily: paiseToRupees(limits.dailyPaise),
      monthly: paiseToRupees(limits.monthlyPaise),
    },
  });
});

// @desc    Spending grouped by category, with a month-by-month trend
// @route   GET /api/transactions/analytics?months=3
// @access  Private
const getSpendingAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 3, 1), 12);

  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  // Only outbound spending counts as "spending"
  const match = {
    sender: userId,
    status: 'SUCCESS',
    type: { $in: ['TRANSFER', 'BILL_PAY', 'WITHDRAW'] },
    createdAt: { $gte: since },
  };

  const [byCategory, byMonth] = await Promise.all([
    Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$category', totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      { $sort: { totalPaise: -1 } },
    ]),
    Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          totalPaise: { $sum: '$amountPaise' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
  ]);

  const totalPaise = byCategory.reduce((sum, row) => sum + row.totalPaise, 0);

  res.json({
    windowMonths: months,
    since,
    totalSpent: paiseToRupees(totalPaise),
    byCategory: byCategory.map((row) => ({
      category: row._id || 'OTHER',
      total: paiseToRupees(row.totalPaise),
      count: row.count,
      // Rounded to 1dp; shares are for display, not accounting
      percentage: totalPaise ? Math.round((row.totalPaise / totalPaise) * 1000) / 10 : 0,
    })),
    trend: byMonth.map((row) => ({
      month: `${row._id.year}-${String(row._id.month).padStart(2, '0')}`,
      total: paiseToRupees(row.totalPaise),
      count: row.count,
    })),
  });
});

// @desc    Download a statement for a date range
// @route   GET /api/transactions/statement?format=csv|pdf&from=&to=
// @access  Private
const downloadStatement = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const format = (req.query.format || 'csv').toLowerCase();

  if (!['csv', 'pdf'].includes(format)) {
    return res.status(400).json({ message: "format must be 'csv' or 'pdf'" });
  }

  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getFullYear(), to.getMonth(), 1);

  const transactions = await Transaction.find({
    participants: userId,
    createdAt: { $gte: from, $lte: to },
  })
    .populate('sender', 'name upiId')
    .populate('receiver', 'name upiId')
    .sort({ createdAt: 1 })
    .limit(5000); // statements are bounded; use a narrower range for more

  const filenameBase = `statement-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}`;

  if (format === 'csv') {
    const csv = buildStatementCsv(transactions, userId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    return res.send(csv);
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  return buildStatementPdf({ transactions, userId, user: req.user, from, to, stream: res });
});

// @desc    Get a single transaction (must be a party to it)
// @route   GET /api/transactions/:txnId
// @access  Private
const getTransactionById = asyncHandler(async (req, res) => {
  const { txnId } = req.params;
  const userId = String(req.user._id);

  const transaction = await Transaction.findById(txnId)
    .populate('sender', 'name phone upiId')
    .populate('receiver', 'name phone upiId');

  if (!transaction) {
    return res.status(404).json({ message: 'Transaction not found' });
  }

  const isParty = transaction.participants.map(String).includes(userId);
  if (!isParty) {
    return res.status(403).json({ message: 'You are not authorized to view this transaction' });
  }

  const ledger = await LedgerEntry.find({ transaction: transaction._id }).sort({ direction: 1 });

  res.json({
    ...serializeTransaction(transaction),
    ledger: ledger.map(serializeLedgerEntry),
  });
});

// @desc    Override the auto-detected spending category
// @route   PATCH /api/transactions/:txnId/category
// @access  Private
const updateTransactionCategory = asyncHandler(async (req, res) => {
  const { category } = req.body;
  const userId = String(req.user._id);

  const transaction = await Transaction.findById(req.params.txnId);
  if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

  if (!transaction.participants.map(String).includes(userId)) {
    return res.status(403).json({ message: 'You are not authorized to modify this transaction' });
  }

  transaction.category = category;
  await transaction.save();

  res.json({ message: 'Category updated', transaction: serializeTransaction(transaction) });
});

// @desc    Refund a received transfer, fully or partially
// @route   POST /api/transactions/:txnId/refund
// @access  Private (MPIN verified by middleware)
const refundTransaction = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const original = await Transaction.findById(req.params.txnId);

  if (!original) return res.status(404).json({ message: 'Transaction not found' });

  if (original.type !== 'TRANSFER') {
    return res.status(400).json({ message: 'Only peer-to-peer transfers can be refunded' });
  }

  // Only the person who RECEIVED the money can send it back
  if (String(original.receiver) !== String(userId)) {
    return res.status(403).json({ message: 'Only the receiver of a transfer can refund it' });
  }

  const remainingPaise = original.amountPaise - original.refundedPaise;
  if (remainingPaise <= 0) {
    return res.status(400).json({ message: 'This transaction has already been fully refunded' });
  }

  const requestedPaise = req.body.amount ? rupeesToPaise(req.body.amount) : remainingPaise;
  if (requestedPaise > remainingPaise) {
    return res.status(400).json({
      message: `Refund exceeds the refundable amount (${paiseToRupees(remainingPaise)} remaining)`,
    });
  }

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'REFUND',
    amountPaise: requestedPaise,
    fromUserId: userId, // receiver pays it back
    toUserId: original.sender,
    refundOf: original._id,
    // Atomically claim the refundable amount inside the same transaction so
    // two concurrent refunds can't over-refund the original.
    beforeCommit: async (session) => {
      const claimed = await Transaction.findOneAndUpdate(
        {
          _id: original._id,
          $expr: { $lte: [{ $add: ['$refundedPaise', requestedPaise] }, '$amountPaise'] },
        },
        {
          $inc: { refundedPaise: requestedPaise },
          $set: {
            status: original.refundedPaise + requestedPaise === original.amountPaise ? 'REVERSED' : 'SUCCESS',
          },
        },
        { new: true, ...(session ? { session } : {}) }
      );

      if (!claimed) throw ApiError.badRequest('Refund exceeds the refundable amount');
    },
  });

  res.status(201).json({
    message: 'Refund processed',
    transaction: serializeTransaction(transaction),
    newBalance: paiseToRupees(senderBalanceAfter),
  });
});

module.exports = {
  sendMoney,
  getTransactionHistory,
  getTransactionSummary,
  getSpendingAnalytics,
  downloadStatement,
  getTransactionById,
  updateTransactionCategory,
  refundTransaction,
  findUserByIdentifier,
};

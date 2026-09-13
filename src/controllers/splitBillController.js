const SplitBill = require('../models/SplitBill');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../config/limits');
const { postTransaction } = require('../services/ledgerService');
const { rupeesToPaise, paiseToRupees, splitPaise } = require('../utils/money');
const { serializeTransaction } = require('../utils/serializers');

const serializeSplit = (bill) => {
  const plain = bill.toObject ? bill.toObject() : bill;
  const { totalPaise, participants, outstandingPaise, __v, ...rest } = plain;

  return {
    ...rest,
    total: paiseToRupees(totalPaise),
    totalPaise,
    outstanding: paiseToRupees(outstandingPaise || 0),
    outstandingPaise: outstandingPaise || 0,
    participants: (participants || []).map((p) => ({
      user: p.user && p.user.name ? { _id: p.user._id, name: p.user.name, upiId: p.user.upiId } : p.user,
      share: paiseToRupees(p.sharePaise),
      sharePaise: p.sharePaise,
      status: p.status,
      transaction: p.transaction,
      paidAt: p.paidAt,
    })),
  };
};

// @desc    Create a split bill
// @route   POST /api/split-bills
// @access  Private
const createSplitBill = asyncHandler(async (req, res) => {
  const { description, participantIdentifiers, includeSelf = true } = req.body;
  const totalPaise = rupeesToPaise(req.body.amount);

  // Resolve every identifier (phone or UPI) to an active user
  const others = await User.find({
    $or: [{ phone: { $in: participantIdentifiers } }, { upiId: { $in: participantIdentifiers } }],
    isActive: { $ne: false },
  }).select('_id name upiId phone');

  const foundKeys = new Set(others.flatMap((u) => [u.phone, u.upiId]));
  const missing = participantIdentifiers.filter((id) => !foundKeys.has(id));
  if (missing.length) {
    return res.status(404).json({ message: 'Some participants were not found', missing });
  }

  const otherIds = others.map((u) => String(u._id)).filter((id) => id !== String(req.user._id));
  if (!otherIds.length) {
    return res.status(400).json({ message: 'Add at least one other participant to split with' });
  }

  const participantIds = includeSelf ? [String(req.user._id), ...otherIds] : otherIds;

  // Exact-paise shares that sum to the total — no rounding loss
  const shares = splitPaise(totalPaise, participantIds.length);

  const participants = participantIds.map((userId, index) => ({
    user: userId,
    sharePaise: shares[index],
    // The creator already paid the bill, so their own share is settled
    status: userId === String(req.user._id) ? 'PAID' : 'PENDING',
    paidAt: userId === String(req.user._id) ? new Date() : undefined,
  }));

  const bill = await SplitBill.create({
    creator: req.user._id,
    description,
    totalPaise,
    participants,
  });

  await bill.populate('participants.user', 'name upiId phone');

  res.status(201).json({ message: 'Split bill created', bill: serializeSplit(bill) });
});

// @desc    List splits I'm involved in
// @route   GET /api/split-bills?status=OPEN|SETTLED
// @access  Private
const listSplitBills = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), limits.maxPageSize);

  const query = { 'participants.user': req.user._id };
  if (req.query.status) query.status = req.query.status;

  const [bills, total] = await Promise.all([
    SplitBill.find(query)
      .populate('participants.user', 'name upiId phone')
      .populate('creator', 'name upiId')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    SplitBill.countDocuments(query),
  ]);

  res.json({
    bills: bills.map(serializeSplit),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

// @desc    Get one split bill
// @route   GET /api/split-bills/:id
// @access  Private
const getSplitBill = asyncHandler(async (req, res) => {
  const bill = await SplitBill.findById(req.params.id)
    .populate('participants.user', 'name upiId phone')
    .populate('creator', 'name upiId');

  if (!bill) return res.status(404).json({ message: 'Split bill not found' });

  const isParticipant = bill.participants.some(
    (p) => String(p.user._id || p.user) === String(req.user._id)
  );
  if (!isParticipant) {
    return res.status(403).json({ message: 'You are not part of this split' });
  }

  res.json(serializeSplit(bill));
});

// @desc    Pay my share to the bill's creator
// @route   POST /api/split-bills/:id/settle
// @access  Private (MPIN verified by middleware)
const settleMyShare = asyncHandler(async (req, res) => {
  const bill = await SplitBill.findById(req.params.id);
  if (!bill) return res.status(404).json({ message: 'Split bill not found' });

  const myShare = bill.participants.find((p) => String(p.user) === String(req.user._id));
  if (!myShare) return res.status(403).json({ message: 'You are not part of this split' });

  if (myShare.status === 'PAID') {
    return res.status(409).json({ message: 'You have already settled your share' });
  }

  if (String(bill.creator) === String(req.user._id)) {
    return res.status(400).json({ message: 'You created this bill — your share is already settled' });
  }

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'TRANSFER',
    amountPaise: myShare.sharePaise,
    fromUserId: req.user._id,
    toUserId: bill.creator,
    reference: { kind: 'SPLIT_BILL', id: bill._id },
  });

  myShare.status = 'PAID';
  myShare.transaction = transaction._id;
  myShare.paidAt = new Date();

  if (bill.participants.every((p) => p.status === 'PAID')) {
    bill.status = 'SETTLED';
  }

  await bill.save();
  await bill.populate('participants.user', 'name upiId phone');

  res.json({
    message: 'Your share has been settled',
    bill: serializeSplit(bill),
    transaction: serializeTransaction(transaction),
    newBalance: paiseToRupees(senderBalanceAfter),
  });
});

module.exports = { createSplitBill, listSplitBills, getSplitBill, settleMyShare };

const PaymentRequest = require('../models/PaymentRequest');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../config/limits');
const { postTransaction } = require('../services/ledgerService');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');
const { serializeTransaction, serializeUser } = require('../utils/serializers');
const { findUserByIdentifier } = require('./txnController');

const serializeRequest = (request) => {
  const plain = request.toObject ? request.toObject() : request;
  const { amountPaise, requester, payer, __v, ...rest } = plain;

  return {
    ...rest,
    amount: paiseToRupees(amountPaise),
    amountPaise,
    requester: requester && requester.name ? serializeUser(requester) : requester,
    payer: payer && payer.name ? serializeUser(payer) : payer,
  };
};

/** Lazily flips PENDING requests that have run out of time. */
const expireIfNeeded = async (request) => {
  if (request.status === 'PENDING' && request.expiresAt < new Date()) {
    request.status = 'EXPIRED';
    await request.save();
  }
  return request;
};

// @desc    Ask another user to pay you
// @route   POST /api/payment-requests
// @access  Private
const createPaymentRequest = asyncHandler(async (req, res) => {
  const { payerIdentifier, note, expiresInHours = 72 } = req.body;
  const amountPaise = rupeesToPaise(req.body.amount);

  const payer = await findUserByIdentifier(payerIdentifier);
  if (!payer) {
    return res.status(404).json({ message: 'That user was not found (invalid phone/UPI)' });
  }

  if (String(payer._id) === String(req.user._id)) {
    return res.status(400).json({ message: 'You cannot request money from yourself' });
  }

  if (amountPaise > limits.perTransactionPaise) {
    return res.status(400).json({
      message: `Requested amount exceeds the per-transaction limit of ${paiseToRupees(limits.perTransactionPaise)}`,
    });
  }

  const request = await PaymentRequest.create({
    requester: req.user._id,
    payer: payer._id,
    amountPaise,
    note,
    expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000),
  });

  await request.populate([
    { path: 'requester', select: 'name upiId phone' },
    { path: 'payer', select: 'name upiId phone' },
  ]);

  res.status(201).json({ message: 'Payment request sent', request: serializeRequest(request) });
});

// @desc    List requests sent to me or by me
// @route   GET /api/payment-requests?direction=incoming|outgoing&status=
// @access  Private
const listPaymentRequests = asyncHandler(async (req, res) => {
  const { direction = 'incoming', status } = req.query;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), limits.maxPageSize);

  const query = direction === 'outgoing' ? { requester: req.user._id } : { payer: req.user._id };
  if (status) query.status = status;

  const [requests, total] = await Promise.all([
    PaymentRequest.find(query)
      .populate('requester', 'name upiId phone')
      .populate('payer', 'name upiId phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PaymentRequest.countDocuments(query),
  ]);

  // Reflect expiry at read time so a stale PENDING never looks payable
  await Promise.all(requests.map(expireIfNeeded));

  res.json({
    direction,
    requests: requests.map(serializeRequest),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

// @desc    Pay a request (this is what actually moves money)
// @route   POST /api/payment-requests/:id/accept
// @access  Private (MPIN verified by middleware)
const acceptPaymentRequest = asyncHandler(async (req, res) => {
  const request = await PaymentRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Payment request not found' });

  if (String(request.payer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Only the person being asked can accept this request' });
  }

  await expireIfNeeded(request);

  if (request.status !== 'PENDING') {
    return res.status(409).json({ message: `This request is already ${request.status.toLowerCase()}` });
  }

  const { transaction, senderBalanceAfter } = await postTransaction({
    type: 'TRANSFER',
    amountPaise: request.amountPaise,
    fromUserId: request.payer,
    toUserId: request.requester,
    reference: { kind: 'PAYMENT_REQUEST', id: request._id },
  });

  request.status = 'ACCEPTED';
  request.transaction = transaction._id;
  request.respondedAt = new Date();
  await request.save();

  res.json({
    message: 'Payment request paid',
    request: serializeRequest(request),
    transaction: serializeTransaction(transaction),
    newBalance: paiseToRupees(senderBalanceAfter),
  });
});

// @desc    Decline a request addressed to me
// @route   POST /api/payment-requests/:id/decline
// @access  Private
const declinePaymentRequest = asyncHandler(async (req, res) => {
  const request = await PaymentRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Payment request not found' });

  if (String(request.payer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Only the person being asked can decline this request' });
  }

  await expireIfNeeded(request);
  if (request.status !== 'PENDING') {
    return res.status(409).json({ message: `This request is already ${request.status.toLowerCase()}` });
  }

  request.status = 'DECLINED';
  request.respondedAt = new Date();
  await request.save();

  res.json({ message: 'Payment request declined', request: serializeRequest(request) });
});

// @desc    Cancel a request I sent
// @route   POST /api/payment-requests/:id/cancel
// @access  Private
const cancelPaymentRequest = asyncHandler(async (req, res) => {
  const request = await PaymentRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Payment request not found' });

  if (String(request.requester) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Only the requester can cancel this request' });
  }

  if (request.status !== 'PENDING') {
    return res.status(409).json({ message: `This request is already ${request.status.toLowerCase()}` });
  }

  request.status = 'CANCELLED';
  request.respondedAt = new Date();
  await request.save();

  res.json({ message: 'Payment request cancelled', request: serializeRequest(request) });
});

module.exports = {
  createPaymentRequest,
  listPaymentRequests,
  acceptPaymentRequest,
  declinePaymentRequest,
  cancelPaymentRequest,
};

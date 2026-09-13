const RecurringPayment = require('../models/RecurringPayment');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../config/limits');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');
const { nextRunDate } = require('../utils/recurrence');
const { findUserByIdentifier } = require('./txnController');

const serializeMandate = (mandate) => {
  const plain = mandate.toObject ? mandate.toObject() : mandate;
  const { amountPaise, payee, __v, ...rest } = plain;

  return {
    ...rest,
    amount: paiseToRupees(amountPaise),
    amountPaise,
    payee: payee && payee.name ? { _id: payee._id, name: payee.name, upiId: payee.upiId } : payee,
  };
};

// @desc    Create an autopay mandate (MPIN verified at creation = authorization)
// @route   POST /api/recurring
// @access  Private (MPIN verified by middleware)
const createMandate = asyncHandler(async (req, res) => {
  const { payeeIdentifier, frequency, note, startAt } = req.body;
  const amountPaise = rupeesToPaise(req.body.amount);

  if (amountPaise > limits.perTransactionPaise) {
    return res.status(400).json({
      message: `Amount exceeds the per-transaction limit of ${paiseToRupees(limits.perTransactionPaise)}`,
    });
  }

  const payee = await findUserByIdentifier(payeeIdentifier);
  if (!payee) return res.status(404).json({ message: 'Payee not found (invalid phone/UPI)' });

  if (String(payee._id) === String(req.user._id)) {
    return res.status(400).json({ message: 'You cannot schedule payments to yourself' });
  }

  const mandate = await RecurringPayment.create({
    user: req.user._id,
    payee: payee._id,
    amountPaise,
    frequency,
    note,
    // Default to one interval from now so nothing charges the instant it's created
    nextRunAt: startAt ? new Date(startAt) : nextRunDate(new Date(), frequency),
    authorizedAt: new Date(),
  });

  await mandate.populate('payee', 'name upiId');

  res.status(201).json({
    message: 'Autopay mandate created. Your MPIN authorized it — future runs happen automatically.',
    mandate: serializeMandate(mandate),
  });
});

// @desc    List my mandates
// @route   GET /api/recurring
// @access  Private
const listMandates = asyncHandler(async (req, res) => {
  const query = { user: req.user._id };
  if (req.query.status) query.status = req.query.status;

  const mandates = await RecurringPayment.find(query)
    .populate('payee', 'name upiId')
    .sort({ createdAt: -1 })
    .limit(limits.maxPageSize);

  res.json({ mandates: mandates.map(serializeMandate) });
});

/** Shared guard: load a mandate that belongs to the caller. */
const loadOwnMandate = async (req, res) => {
  const mandate = await RecurringPayment.findById(req.params.id).populate('payee', 'name upiId');
  if (!mandate) {
    res.status(404).json({ message: 'Mandate not found' });
    return null;
  }
  if (String(mandate.user) !== String(req.user._id)) {
    res.status(403).json({ message: 'This mandate does not belong to you' });
    return null;
  }
  return mandate;
};

// @desc    Pause an active mandate
// @route   POST /api/recurring/:id/pause
// @access  Private
const pauseMandate = asyncHandler(async (req, res) => {
  const mandate = await loadOwnMandate(req, res);
  if (!mandate) return undefined;

  if (mandate.status !== 'ACTIVE') {
    return res.status(409).json({ message: `Mandate is ${mandate.status.toLowerCase()}, not active` });
  }

  mandate.status = 'PAUSED';
  await mandate.save();
  return res.json({ message: 'Mandate paused', mandate: serializeMandate(mandate) });
});

// @desc    Resume a paused mandate
// @route   POST /api/recurring/:id/resume
// @access  Private
const resumeMandate = asyncHandler(async (req, res) => {
  const mandate = await loadOwnMandate(req, res);
  if (!mandate) return undefined;

  if (!['PAUSED', 'FAILED'].includes(mandate.status)) {
    return res.status(409).json({ message: `Mandate is ${mandate.status.toLowerCase()} and cannot be resumed` });
  }

  mandate.status = 'ACTIVE';
  mandate.failureCount = 0;
  mandate.lastError = undefined;
  // Never resume into the past — that would fire immediately
  if (mandate.nextRunAt < new Date()) {
    mandate.nextRunAt = nextRunDate(new Date(), mandate.frequency);
  }
  await mandate.save();

  return res.json({ message: 'Mandate resumed', mandate: serializeMandate(mandate) });
});

// @desc    Cancel a mandate permanently
// @route   DELETE /api/recurring/:id
// @access  Private
const cancelMandate = asyncHandler(async (req, res) => {
  const mandate = await loadOwnMandate(req, res);
  if (!mandate) return undefined;

  mandate.status = 'CANCELLED';
  await mandate.save();
  return res.json({ message: 'Mandate cancelled', mandate: serializeMandate(mandate) });
});

module.exports = { createMandate, listMandates, pauseMandate, resumeMandate, cancelMandate };

const mongoose = require('mongoose');

/**
 * A recurring payment mandate (autopay).
 *
 * IMPORTANT: the MPIN is never stored. The user verifies their MPIN once,
 * when creating the mandate — that verification IS the authorization for
 * future runs, which is how real e-mandates work. The worker then executes
 * without any credential, and the user can pause or cancel at any time.
 *
 * Idempotency lives in the Transaction model: each run writes
 * reference.periodKey (e.g. "2026-09-09") under a partial unique index, so
 * a restarted or duplicated worker physically cannot charge twice for the
 * same period.
 */
const recurringPaymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    payee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer' },
    },
    note: {
      type: String,
      maxlength: 140,
    },
    frequency: {
      type: String,
      enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
      required: true,
    },
    nextRunAt: {
      type: Date,
      required: true,
    },
    lastRunAt: Date,
    lastError: String,
    runCount: {
      type: Number,
      default: 0,
    },
    failureCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED'],
      default: 'ACTIVE',
    },
    /** When the user MPIN-authorized this mandate. */
    authorizedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

recurringPaymentSchema.index({ status: 1, nextRunAt: 1 }); // the worker's due query
recurringPaymentSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('RecurringPayment', recurringPaymentSchema);

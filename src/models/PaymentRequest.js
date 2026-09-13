const mongoose = require('mongoose');

/**
 * "Request money from X" — a pending ask that the payer can accept or
 * decline. Accepting is what actually moves money (through ledgerService),
 * so a request on its own never changes a balance.
 *
 * State machine: PENDING -> ACCEPTED | DECLINED | CANCELLED | EXPIRED
 */
const paymentRequestSchema = new mongoose.Schema(
  {
    requester: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true, // who wants to be paid
    },
    payer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true, // who is being asked
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
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
      default: 'PENDING',
    },
    /** Set once accepted — the transfer this request produced. */
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    respondedAt: Date,
  },
  { timestamps: true }
);

paymentRequestSchema.index({ payer: 1, status: 1, createdAt: -1 });
paymentRequestSchema.index({ requester: 1, status: 1, createdAt: -1 });
paymentRequestSchema.index({ status: 1, expiresAt: 1 }); // for the expiry sweep

module.exports = mongoose.model('PaymentRequest', paymentRequestSchema);

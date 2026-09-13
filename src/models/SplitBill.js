const mongoose = require('mongoose');

/**
 * Split a bill across several people. Shares are computed in exact paise
 * (see utils/money.splitPaise) so they always sum to the total — no rupee
 * disappearing to rounding when ₹100 splits three ways.
 *
 * The creator paid the bill up front, so their own share starts as PAID and
 * everyone else settles to them.
 */
const participantSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sharePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'sharePaise must be an integer' },
    },
    status: {
      type: String,
      enum: ['PENDING', 'PAID'],
      default: 'PENDING',
    },
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    paidAt: Date,
  },
  { _id: false }
);

const splitBillSchema = new mongoose.Schema(
  {
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    description: {
      type: String,
      required: true,
      maxlength: 140,
    },
    totalPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'totalPaise must be an integer' },
    },
    participants: {
      type: [participantSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 2,
        message: 'A split needs at least two participants (including you)',
      },
    },
    status: {
      type: String,
      enum: ['OPEN', 'SETTLED'],
      default: 'OPEN',
    },
  },
  { timestamps: true }
);

splitBillSchema.index({ creator: 1, createdAt: -1 });
splitBillSchema.index({ 'participants.user': 1, status: 1, createdAt: -1 });

/** Paise still owed to the creator across all participants. */
splitBillSchema.virtual('outstandingPaise').get(function outstanding() {
  return this.participants
    .filter((p) => p.status === 'PENDING')
    .reduce((total, p) => total + p.sharePaise, 0);
});

splitBillSchema.set('toObject', { virtuals: true });
splitBillSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SplitBill', splitBillSchema);

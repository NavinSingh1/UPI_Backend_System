const mongoose = require('mongoose');

const TRANSACTION_TYPES = ['TRANSFER', 'ADD_MONEY', 'WITHDRAW', 'BILL_PAY', 'REFUND'];
const CATEGORIES = ['TRANSFER', 'FOOD', 'TRAVEL', 'BILLS', 'SHOPPING', 'ENTERTAINMENT', 'RECHARGE', 'OTHER'];

const transactionSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Absent on ADD_MONEY (money originates at the bank, not a user)
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Absent on WITHDRAW / BILL_PAY (money leaves to a bank/biller)
    },
    /**
     * Both parties in one indexed array. The old history query was
     * `find({ $or: [{sender}, {receiver}] }).sort({createdAt:-1})`, which
     * can't use a single index efficiently. Querying `participants: userId`
     * with the compound index below is one index scan instead.
     */
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    type: {
      type: String,
      enum: TRANSACTION_TYPES,
      default: 'TRANSFER',
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'OTHER',
    },
    billerName: {
      type: String, // e.g. "Jio Mobile Recharge" or "Adani Electricity"
    },
    /** Amount in INTEGER PAISE — never a float. See utils/money.js. */
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise',
      },
    },
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'PENDING', 'REVERSED'],
      default: 'SUCCESS',
    },
    /** Set on a REFUND transaction, pointing at the transaction being refunded. */
    refundOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    /** Running total already refunded against THIS transaction (guards over-refunding). */
    refundedPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Links a transaction back to whatever caused it. `periodKey` is what
     * makes recurring payments idempotent: the partial unique index below
     * means a given mandate can only ever produce one transaction per
     * period, even if the worker restarts or two instances run at once.
     */
    reference: {
      kind: {
        type: String,
        enum: ['PAYMENT_REQUEST', 'SPLIT_BILL', 'RECURRING'],
      },
      id: {
        type: mongoose.Schema.Types.ObjectId,
      },
      periodKey: {
        type: String, // e.g. "2026-09-09"
      },
    },
  },
  {
    timestamps: true,
  }
);

// Primary history query: one user's transactions, newest first
transactionSchema.index({ participants: 1, createdAt: -1 });
// Filtered history (?type=TRANSFER) for one user
transactionSchema.index({ participants: 1, type: 1, createdAt: -1 });
// Spending limit checks: one user's outbound transactions in a time window
transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, createdAt: -1 });
transactionSchema.index({ refundOf: 1 });
// DB-enforced idempotency for scheduled/recurring runs
transactionSchema.index(
  { 'reference.kind': 1, 'reference.id': 1, 'reference.periodKey': 1 },
  { unique: true, partialFilterExpression: { 'reference.periodKey': { $type: 'string' } } }
);

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
module.exports.CATEGORIES = CATEGORIES;

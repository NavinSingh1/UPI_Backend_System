const mongoose = require('mongoose');

/**
 * Double-entry ledger — the source of truth for all money in the system.
 *
 * Every transaction writes exactly two entries that sum to zero: one DEBIT
 * and one CREDIT of the same amount. `User.balancePaise` is a materialized
 * projection of these entries, not the truth itself, which means a drift
 * between the two is detectable (see services/ledgerService.reconcileUser)
 * rather than silent.
 *
 * CONVENTION (wallet-holder's perspective):
 *   DEBIT  = money leaving that account
 *   CREDIT = money entering that account
 *
 * When one side isn't a user (topping up from a bank, paying a biller),
 * `account` is null and `externalAccount` names the counter-party, so the
 * two entries still balance.
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null = external (non-user) account
    },
    externalAccount: {
      type: String,
      enum: ['BANK', 'BILLER', 'SYSTEM'],
    },
    direction: {
      type: String,
      enum: ['DEBIT', 'CREDIT'],
      required: true,
    },
    /** Always a positive integer; `direction` carries the sign. */
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise',
      },
    },
    /** Snapshot of the account's balance right after this entry (audit trail). */
    balanceAfterPaise: {
      type: Number,
    },
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ account: 1, createdAt: -1 });
ledgerEntrySchema.index({ transaction: 1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);

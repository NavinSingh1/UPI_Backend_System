const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    // User gets a UPI ID on signup
    upiId: {
      type: String,
      unique: true,
    },
    // MPIN for transactions (stored as a bcrypt hash)
    mpin: {
      type: String,
    },
    /**
     * Materialized wallet balance in INTEGER PAISE.
     *
     * The double-entry ledger (see models/LedgerEntry.js) is the source of
     * truth; this field is a cached projection of it, updated atomically in
     * the same transaction as the ledger writes so reads stay fast. Run
     * `npm run reconcile` to verify this still equals the ledger sum.
     */
    balancePaise: {
      type: Number,
      default: 0, // opening balance is posted through the ledger at registration
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'balancePaise must be an integer number of paise',
      },
    },
    // Soft delete: deactivated accounts keep their history but can't authenticate
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model('User', userSchema);
module.exports = User;

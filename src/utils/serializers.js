const { paiseToRupees } = require('./money');

/**
 * The database stores integer paise; the API speaks rupees. These
 * serializers are the single conversion point on the way out, so no
 * controller ever hand-divides by 100.
 *
 * Each payload keeps both `amount` (rupees, for humans and existing
 * clients) and `amountPaise` (exact integer, for anything doing math).
 */
const serializeUser = (user) => {
  if (!user) return null;
  const plain = user.toObject ? user.toObject() : user;

  const { password, mpin, balancePaise, __v, ...rest } = plain;

  return {
    ...rest,
    ...(balancePaise !== undefined
      ? { balance: paiseToRupees(balancePaise), balancePaise }
      : {}),
  };
};

const serializeTransaction = (txn) => {
  if (!txn) return null;
  const plain = txn.toObject ? txn.toObject() : txn;
  const { amountPaise, refundedPaise, sender, receiver, __v, ...rest } = plain;

  return {
    ...rest,
    amount: paiseToRupees(amountPaise),
    amountPaise,
    ...(refundedPaise !== undefined
      ? { refunded: paiseToRupees(refundedPaise), refundedPaise }
      : {}),
    sender: sender && sender.name ? serializeUser(sender) : sender,
    receiver: receiver && receiver.name ? serializeUser(receiver) : receiver,
  };
};

const serializeLedgerEntry = (entry) => {
  if (!entry) return null;
  const plain = entry.toObject ? entry.toObject() : entry;
  const { amountPaise, balanceAfterPaise, __v, ...rest } = plain;

  return {
    ...rest,
    amount: paiseToRupees(amountPaise),
    amountPaise,
    ...(balanceAfterPaise !== undefined && balanceAfterPaise !== null
      ? { balanceAfter: paiseToRupees(balanceAfterPaise), balanceAfterPaise }
      : {}),
  };
};

module.exports = { serializeUser, serializeTransaction, serializeLedgerEntry };

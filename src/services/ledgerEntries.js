/**
 * Pure (no database) helpers for the double-entry ledger.
 *
 * Keeping the "which side is debited" decision and the balancing invariant
 * in a dependency-free module means they can be unit-tested without a
 * MongoDB instance — see tests/unit/ledger.test.js.
 */

/**
 * Builds the two balanced ledger entries for a money movement.
 *
 * @returns {Array<{account: string|null, externalAccount?: string, direction: 'DEBIT'|'CREDIT', amountPaise: number}>}
 */
const buildEntries = ({ type, amountPaise, fromUserId = null, toUserId = null }) => {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('amountPaise must be a positive integer');
  }

  const debit = (account, externalAccount) => ({
    account: account ? String(account) : null,
    ...(externalAccount ? { externalAccount } : {}),
    direction: 'DEBIT',
    amountPaise,
  });

  const credit = (account, externalAccount) => ({
    account: account ? String(account) : null,
    ...(externalAccount ? { externalAccount } : {}),
    direction: 'CREDIT',
    amountPaise,
  });

  switch (type) {
    // User A pays User B (also covers REFUND, which is just a transfer back)
    case 'TRANSFER':
    case 'REFUND':
      if (!fromUserId || !toUserId) {
        throw new Error(`${type} requires both fromUserId and toUserId`);
      }
      return [debit(fromUserId), credit(toUserId)];

    // Money enters the system from the user's linked bank
    case 'ADD_MONEY':
      if (!toUserId) throw new Error('ADD_MONEY requires toUserId');
      return [debit(null, 'BANK'), credit(toUserId)];

    // Money leaves the system back to the user's bank
    case 'WITHDRAW':
      if (!fromUserId) throw new Error('WITHDRAW requires fromUserId');
      return [debit(fromUserId), credit(null, 'BANK')];

    // Money leaves the system to a utility/biller
    case 'BILL_PAY':
      if (!fromUserId) throw new Error('BILL_PAY requires fromUserId');
      return [debit(fromUserId), credit(null, 'BILLER')];

    default:
      throw new Error(`Unknown transaction type: ${type}`);
  }
};

/**
 * The core accounting invariant: debits must equal credits. Called on every
 * write, so an imbalance fails loudly at the moment it's introduced instead
 * of being discovered later during reconciliation.
 */
const assertBalanced = (entries) => {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error('A balanced transaction needs at least two ledger entries');
  }

  const sum = (direction) =>
    entries.filter((e) => e.direction === direction).reduce((total, e) => total + e.amountPaise, 0);

  const debits = sum('DEBIT');
  const credits = sum('CREDIT');

  if (debits !== credits) {
    throw new Error(`Ledger imbalance: debits ${debits} !== credits ${credits}`);
  }

  return true;
};

/** Net effect of a set of entries on one account, in paise (credits positive). */
const netForAccount = (entries, accountId) =>
  entries
    .filter((e) => e.account && String(e.account) === String(accountId))
    .reduce((total, e) => total + (e.direction === 'CREDIT' ? e.amountPaise : -e.amountPaise), 0);

module.exports = { buildEntries, assertBalanced, netForAccount };

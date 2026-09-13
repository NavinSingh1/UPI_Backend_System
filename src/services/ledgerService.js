const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LedgerEntry = require('../models/LedgerEntry');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const transactionEvents = require('../utils/events');
const { inferCategory } = require('../utils/categories');
const { withTransaction } = require('../utils/dbTransaction');
const { buildEntries, assertBalanced } = require('./ledgerEntries');
const { deleteCache, deleteCacheByPrefix } = require('../utils/cache');

/**
 * The ONE place money moves.
 *
 * Every endpoint that changes a balance (transfer, top-up, withdraw, bill
 * pay, refund, split settlement, recurring run) goes through
 * postTransaction, which guarantees:
 *
 *  1. No overdraft, even under concurrency. The debit is a single
 *     conditional `findOneAndUpdate` with `balancePaise: { $gte: amount }`
 *     — the check and the write are the same atomic operation, so two
 *     simultaneous transfers can't both pass the check (the old
 *     read-then-write code had exactly that race).
 *  2. All-or-nothing. On a replica set this runs in a real MongoDB
 *     transaction; on a standalone mongod we register compensating writes
 *     and unwind them in reverse on failure.
 *  3. Balanced books. Two ledger entries per transaction, debits === credits,
 *     asserted before anything is written.
 */
const postTransaction = async ({
  type,
  amountPaise,
  fromUserId = null,
  toUserId = null,
  billerName,
  category,
  refundOf,
  reference,
  status = 'SUCCESS',
  /** Optional hook run INSIDE the transaction, before money moves. */
  beforeCommit,
}) => {
  // Fail fast on unbalanced/invalid movements before touching the database
  const entryPlan = buildEntries({ type, amountPaise, fromUserId, toUserId });
  assertBalanced(entryPlan);

  if (fromUserId && toUserId && String(fromUserId) === String(toUserId)) {
    throw ApiError.badRequest('Sender and receiver cannot be the same account');
  }

  const result = await withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    const rollbacks = [];

    try {
      if (beforeCommit) await beforeCommit(session);

      let senderBalanceAfter;
      let receiverBalanceAfter;

      // ---- Debit side: atomic, guarded against overdraft ----
      if (fromUserId) {
        const debited = await User.findOneAndUpdate(
          { _id: fromUserId, isActive: { $ne: false }, balancePaise: { $gte: amountPaise } },
          { $inc: { balancePaise: -amountPaise } },
          { new: true, ...sessionOpt }
        );

        if (!debited) {
          // Distinguish "no such account" from "not enough money"
          const exists = await User.findOne({ _id: fromUserId, isActive: { $ne: false } })
            .select('_id')
            .setOptions(sessionOpt);
          throw exists
            ? ApiError.badRequest('Insufficient balance')
            : ApiError.notFound('Sender account not found or inactive');
        }

        senderBalanceAfter = debited.balancePaise;
        if (!session) {
          rollbacks.push(() => User.updateOne({ _id: fromUserId }, { $inc: { balancePaise: amountPaise } }));
        }
      }

      // ---- Credit side ----
      if (toUserId) {
        const credited = await User.findOneAndUpdate(
          { _id: toUserId, isActive: { $ne: false } },
          { $inc: { balancePaise: amountPaise } },
          { new: true, ...sessionOpt }
        );

        if (!credited) throw ApiError.notFound('Receiver account not found or inactive');

        receiverBalanceAfter = credited.balancePaise;
        if (!session) {
          rollbacks.push(() => User.updateOne({ _id: toUserId }, { $inc: { balancePaise: -amountPaise } }));
        }
      }

      // ---- Transaction record ----
      const [transaction] = await Transaction.create(
        [
          {
            sender: fromUserId || undefined,
            receiver: toUserId || undefined,
            participants: [fromUserId, toUserId].filter(Boolean),
            type,
            category: category || inferCategory(type, billerName),
            billerName,
            amountPaise,
            status,
            refundOf,
            ...(reference ? { reference } : {}),
          },
        ],
        sessionOpt
      );

      if (!session) {
        rollbacks.push(() => Transaction.deleteOne({ _id: transaction._id }));
      }

      // ---- Ledger entries (always exactly balanced) ----
      const balanceAfterFor = (accountId) => {
        if (!accountId) return undefined;
        if (fromUserId && String(accountId) === String(fromUserId)) return senderBalanceAfter;
        if (toUserId && String(accountId) === String(toUserId)) return receiverBalanceAfter;
        return undefined;
      };

      const entryDocs = entryPlan.map((entry) => ({
        transaction: transaction._id,
        account: entry.account || null,
        externalAccount: entry.externalAccount,
        direction: entry.direction,
        amountPaise: entry.amountPaise,
        balanceAfterPaise: balanceAfterFor(entry.account),
      }));

      await LedgerEntry.create(entryDocs, sessionOpt);

      if (!session) {
        rollbacks.push(() => LedgerEntry.deleteMany({ transaction: transaction._id }));
      }

      return { transaction, senderBalanceAfter, receiverBalanceAfter };
    } catch (err) {
      // With a session, withTransaction() aborts and Mongo rolls back for us.
      // Without one, undo whatever already landed, newest first.
      if (!session && rollbacks.length) {
        for (const undo of rollbacks.reverse()) {
          try {
            await undo();
          } catch (rollbackErr) {
            logger.error(
              { err: rollbackErr, type, fromUserId, toUserId, amountPaise },
              'CRITICAL: compensating write failed — balances may need reconciliation'
            );
          }
        }
      }
      throw err;
    }
  });

  // Side effects run only after the money is durably committed, so a
  // transaction retry can't double-send a notification.
  await invalidateForUsers([fromUserId, toUserId]);

  if (toUserId && type !== 'ADD_MONEY') {
    const receiverUser = await User.findById(toUserId).select('name email balancePaise');
    transactionEvents.emit('transaction:success', {
      transaction: result.transaction,
      receiverUser,
    });
  }

  return result; // { transaction, senderBalanceAfter, receiverBalanceAfter }
};

/** Drops cached balances/histories for everyone touched by a transaction. */
const invalidateForUsers = async (userIds) => {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  await Promise.all(
    unique.flatMap((id) => [
      deleteCache(`user:balance:${id}`),
      deleteCache(`user:profile:${id}`),
      deleteCacheByPrefix(`user:txn:${id}`),
    ])
  );
};

/**
 * Balance derived by summing the ledger — the authoritative figure.
 * `User.balancePaise` should always equal this.
 */
const computeLedgerBalancePaise = async (userId) => {
  const accountId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  const [row] = await LedgerEntry.aggregate([
    { $match: { account: accountId } },
    {
      $group: {
        _id: null,
        credits: { $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountPaise', 0] } },
        debits: { $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountPaise', 0] } },
      },
    },
  ]);

  if (!row) return 0;
  return row.credits - row.debits;
};

/**
 * Compares the materialized balance against the ledger. Any non-zero drift
 * means a bug (or a failed compensating write) and should be investigated —
 * run via `npm run reconcile`.
 */
const reconcileUser = async (userId) => {
  const user = await User.findById(userId).select('name upiId balancePaise');
  if (!user) throw ApiError.notFound('User not found');

  // Every account's opening balance is itself posted as a ledger entry at
  // registration (and by the migration script for pre-existing users), so a
  // healthy account always sums exactly to its cached balance.
  const derivedPaise = await computeLedgerBalancePaise(user._id);
  const driftPaise = user.balancePaise - derivedPaise;

  return {
    userId: String(user._id),
    name: user.name,
    upiId: user.upiId,
    cachedPaise: user.balancePaise,
    derivedPaise,
    driftPaise,
    balanced: driftPaise === 0,
  };
};

module.exports = { postTransaction, computeLedgerBalancePaise, reconcileUser, invalidateForUsers };

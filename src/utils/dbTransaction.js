const mongoose = require('mongoose');

/**
 * MongoDB multi-document transactions require a replica set (or mongos).
 * A plain standalone `mongod` — which is what most people run locally —
 * throws "Transaction numbers are only allowed on a replica set member".
 *
 * So we probe once at startup and remember the answer:
 *   - replica set  -> real ACID transactions via session.withTransaction()
 *   - standalone   -> run the callback without a session, relying on the
 *                     conditional atomic $inc in ledgerService to prevent
 *                     overdrafts, plus compensating writes on failure.
 *
 * docker-compose.yml in this repo starts Mongo as a single-node replica set
 * specifically so you get the real thing in development.
 */
let transactionsSupported = null;

const MODE = (process.env.MONGO_TRANSACTIONS || 'auto').toLowerCase(); // auto | on | off

const probeTransactionSupport = async () => {
  if (MODE === 'on') return true;
  if (MODE === 'off') return false;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await session.abortTransaction();
    return true;
  } catch (err) {
    return false;
  } finally {
    await session.endSession();
  }
};

/** Called once from server.js after the DB connects. Safe to skip (lazy probe below). */
const initTransactionSupport = async () => {
  transactionsSupported = await probeTransactionSupport();
  console.log(
    transactionsSupported
      ? '✅ MongoDB transactions available (replica set) — money moves are fully atomic'
      : 'ℹ️  MongoDB standalone detected — using atomic $inc + compensating writes instead of transactions'
  );
  return transactionsSupported;
};

const isTransactionSupported = () => transactionsSupported === true;

/**
 * Runs `work(session)` inside a transaction when the deployment supports one,
 * otherwise runs `work(null)`. Callers MUST write their money logic so it is
 * still safe with a null session (see ledgerService).
 */
const withTransaction = async (work) => {
  if (transactionsSupported === null) {
    transactionsSupported = await probeTransactionSupport();
  }

  if (!transactionsSupported) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { withTransaction, initTransactionSupport, isTransactionSupported };

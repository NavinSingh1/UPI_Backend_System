const cron = require('node-cron');
const RecurringPayment = require('../models/RecurringPayment');
const PaymentRequest = require('../models/PaymentRequest');
const logger = require('../utils/logger');
const { postTransaction } = require('../services/ledgerService');
const { periodKey, nextRunDate } = require('../utils/recurrence');

const MAX_FAILURES = Number(process.env.RECURRING_MAX_FAILURES || 3);

/**
 * Executes every mandate that is due.
 *
 * Double-charge safety comes from the database, not from this loop: each run
 * writes reference.periodKey under a partial UNIQUE index, so if the worker
 * restarts mid-run, or two instances tick at the same time, the second
 * insert fails with a duplicate-key error (11000) which we treat as
 * "already processed" rather than an error.
 */
const runDueMandates = async (now = new Date()) => {
  const due = await RecurringPayment.find({
    status: 'ACTIVE',
    nextRunAt: { $lte: now },
  }).limit(200);

  const results = { processed: 0, skipped: 0, failed: 0 };

  for (const mandate of due) {
    const key = periodKey(mandate.nextRunAt);

    try {
      const { transaction } = await postTransaction({
        type: 'TRANSFER',
        amountPaise: mandate.amountPaise,
        fromUserId: mandate.user,
        toUserId: mandate.payee,
        reference: { kind: 'RECURRING', id: mandate._id, periodKey: key },
      });

      mandate.lastRunAt = now;
      mandate.runCount += 1;
      mandate.failureCount = 0;
      mandate.lastError = undefined;
      mandate.nextRunAt = nextRunDate(mandate.nextRunAt, mandate.frequency);
      await mandate.save();

      results.processed += 1;
      logger.info(
        { mandateId: String(mandate._id), transactionId: String(transaction._id), periodKey: key },
        'Recurring payment executed'
      );
    } catch (err) {
      // Duplicate key = this period was already charged. Advance and move on.
      if (err?.code === 11000) {
        mandate.nextRunAt = nextRunDate(mandate.nextRunAt, mandate.frequency);
        await mandate.save();
        results.skipped += 1;
        logger.warn({ mandateId: String(mandate._id), periodKey: key }, 'Recurring period already charged — skipping');
        continue;
      }

      mandate.failureCount += 1;
      mandate.lastError = err.message;

      // Insufficient funds shouldn't retry forever; park it and let the user act
      if (mandate.failureCount >= MAX_FAILURES) {
        mandate.status = 'FAILED';
      } else {
        mandate.nextRunAt = nextRunDate(mandate.nextRunAt, mandate.frequency);
      }

      await mandate.save();
      results.failed += 1;
      logger.error(
        { err, mandateId: String(mandate._id), failureCount: mandate.failureCount },
        'Recurring payment failed'
      );
    }
  }

  return results;
};

/** Marks payment requests past their expiry as EXPIRED. */
const expireStalePaymentRequests = async (now = new Date()) => {
  const { modifiedCount } = await PaymentRequest.updateMany(
    { status: 'PENDING', expiresAt: { $lt: now } },
    { $set: { status: 'EXPIRED' } }
  );

  if (modifiedCount) logger.info({ modifiedCount }, 'Expired stale payment requests');
  return modifiedCount;
};

let task;

/**
 * Starts the scheduler. Runs every 5 minutes by default — frequently enough
 * that a DAILY mandate fires close to its time, cheap enough to ignore.
 */
const startRecurringWorker = () => {
  if (process.env.DISABLE_WORKER === 'true' || process.env.NODE_ENV === 'test') {
    logger.info('Recurring worker disabled');
    return null;
  }

  const schedule = process.env.RECURRING_CRON || '*/5 * * * *';

  task = cron.schedule(schedule, async () => {
    try {
      const results = await runDueMandates();
      await expireStalePaymentRequests();
      if (results.processed || results.failed || results.skipped) {
        logger.info(results, 'Recurring worker tick complete');
      }
    } catch (err) {
      logger.error({ err }, 'Recurring worker tick failed');
    }
  });

  logger.info({ schedule }, 'Recurring payment worker started');
  return task;
};

const stopRecurringWorker = () => {
  if (task) {
    task.stop();
    logger.info('Recurring payment worker stopped');
  }
};

module.exports = { startRecurringWorker, stopRecurringWorker, runDueMandates, expireStalePaymentRequests };

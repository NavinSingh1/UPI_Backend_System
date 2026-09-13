const EventEmitter = require('events');
const logger = require('./logger');
const { enqueue } = require('../queues/notificationQueue');

/**
 * In-process domain event bus.
 *
 * The emitter is deliberately kept as a fan-out point — it's cheap and useful
 * for in-process concerns like counters. What it is NOT is a delivery
 * guarantee: anything that must survive a crash gets handed to the durable
 * notification queue instead of being done inline here.
 *
 * So the layering is: ledgerService emits a domain event -> this listener
 * translates it into a queue job -> the worker process delivers it with
 * retries and a dead-letter queue.
 */
const transactionEvents = new EventEmitter();

transactionEvents.on('transaction:success', async ({ transaction, receiverUser }) => {
  logger.info(
    { transactionId: String(transaction._id), type: transaction.type, amountPaise: transaction.amountPaise },
    'Transaction committed'
  );

  if (!receiverUser?.email) return;

  // jobId makes this idempotent: if the same transaction were somehow
  // announced twice, the second enqueue is a no-op rather than a second email.
  await enqueue(
    'transaction:notify',
    {
      transactionId: String(transaction._id),
      type: transaction.type,
      amountPaise: transaction.amountPaise,
      receiverEmail: receiverUser.email,
      receiverName: receiverUser.name,
    },
    { jobId: `txn-notify-${transaction._id}` }
  );
});

module.exports = transactionEvents;

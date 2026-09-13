require('dotenv').config();

/**
 * Standalone worker process.
 *
 * Once the API runs as multiple replicas behind the load balancer, background
 * work must NOT live inside those replicas: three API containers would mean
 * three autopay schedulers ticking. So the API sets DISABLE_WORKER=true and
 * this process owns all background work:
 *
 *   - the BullMQ notification consumer (retries + dead-letter queue)
 *   - the recurring-payment cron scheduler
 *   - the payment-request expiry sweep
 *
 * Run one instance of this. It needs no inbound port.
 */
const REQUIRED_ENV_VARS = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Worker missing required environment variable(s): ${missing.join(', ')}`);
  process.exit(1);
}

const mongoose = require('mongoose');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');
const { initTransactionSupport } = require('./src/utils/dbTransaction');
const { startRecurringWorker, stopRecurringWorker } = require('./src/workers/recurringWorker');
const { startNotificationWorker, stopNotificationWorker } = require('./src/queues/notificationWorker');
const { closeQueues } = require('./src/queues/notificationQueue');
const { closeQueueConnection } = require('./src/queues/connection');

const start = async () => {
  await connectDB();
  await initTransactionSupport();

  // The cron scheduler checks DISABLE_WORKER itself, so make sure it's off here
  delete process.env.DISABLE_WORKER;

  startNotificationWorker();
  startRecurringWorker();

  logger.info('👷 Worker process ready (notifications + recurring payments)');
};

start().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});

const shutdown = async (signal) => {
  logger.info(`${signal} received. Worker shutting down gracefully...`);

  // Stop taking new work first, then let in-flight jobs finish
  stopRecurringWorker();
  await stopNotificationWorker();
  await closeQueues();
  await closeQueueConnection();

  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed.');
  } catch (err) {
    logger.error({ err }, 'Error closing MongoDB connection');
  }

  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Worker unhandled rejection'));

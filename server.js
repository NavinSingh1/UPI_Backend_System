require('dotenv').config();

// Env validation at startup — catch missing config early (clear error, exit)
// instead of failing halfway through a request.
const REQUIRED_ENV_VARS = ['PORT', 'MONGODB_URI', 'JWT_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('   Check your .env file against .env.example and try again.');
  process.exit(1);
}

const mongoose = require('mongoose');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const redisClient = require('./src/config/redis');
const logger = require('./src/utils/logger');
const { initTransactionSupport } = require('./src/utils/dbTransaction');
const { startRecurringWorker, stopRecurringWorker } = require('./src/workers/recurringWorker');
const { closeQueues } = require('./src/queues/notificationQueue');
const { closeQueueConnection } = require('./src/queues/connection');

/**
 * Running behind a load balancer (TRUST_PROXY_HOPS > 0) means several
 * replicas share this database. Redis stops being optional at that point:
 * the in-memory fallbacks for the JWT blacklist, idempotency keys and
 * rate-limit counters are per-process, so without Redis a token revoked on
 * one replica stays valid on the others.
 */
if (Number(process.env.TRUST_PROXY_HOPS || 0) > 0 && !process.env.REDIS_URL) {
  logger.error(
    'Running behind a proxy without REDIS_URL: the JWT blacklist, idempotency keys and rate-limit ' +
      'counters would be per-instance and inconsistent. Set REDIS_URL for multi-instance deployments.'
  );
}

const PORT = process.env.PORT || 5000;
let server;

const start = async () => {
  await connectDB();

  // Decide once whether real MongoDB transactions are available
  await initTransactionSupport();

  // Autopay scheduler. In a multi-replica deployment this is disabled here
  // (DISABLE_WORKER=true) and owned by the standalone worker.js process
  // instead, so three API containers don't mean three schedulers.
  startRecurringWorker();

  server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📖 Swagger Docs available at http://localhost:${PORT}/api-docs`);
  });
};

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then close the worker, DB and Redis — so a deploy can't cut a
 * transaction off mid-write.
 */
const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);

  stopRecurringWorker();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed.');
  }

  await closeQueues();
  await closeQueueConnection();

  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed.');
  } catch (err) {
    logger.error({ err }, 'Error closing MongoDB connection');
  }

  if (redisClient) {
    redisClient.disconnect();
    logger.info('Redis connection closed.');
  }

  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Never leave the process in an unknown state after an unhandled failure
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

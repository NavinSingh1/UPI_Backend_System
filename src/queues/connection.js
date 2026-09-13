const Redis = require('ioredis');
const logger = require('../utils/logger');

/**
 * BullMQ needs its OWN Redis connection, separate from the caching client in
 * src/config/redis.js, for two reasons:
 *
 *  1. BullMQ requires `maxRetriesPerRequest: null` because it holds blocking
 *     BRPOPLPUSH connections. The cache client deliberately uses
 *     `maxRetriesPerRequest: 1` so a sick Redis fails fast instead of hanging
 *     a request — the two settings are incompatible.
 *  2. A blocking connection can't be shared with request-path commands.
 *
 * If REDIS_URL isn't set we return null and the queue layer degrades to
 * in-process delivery (see notificationQueue.js).
 */
let connection = null;
let attempted = false;

const getQueueConnection = () => {
  if (attempted) return connection;
  attempted = true;

  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — notification queue will run in-process (jobs are NOT durable)');
    return null;
  }

  connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: true,
  });

  connection.on('error', (err) => logger.error({ err }, 'Queue Redis connection error'));
  connection.on('connect', () => logger.info('Queue Redis connected'));

  return connection;
};

const closeQueueConnection = async () => {
  if (connection) {
    await connection.quit().catch(() => connection.disconnect());
    connection = null;
    attempted = false;
  }
};

const isQueueEnabled = () => getQueueConnection() !== null;

module.exports = { getQueueConnection, closeQueueConnection, isQueueEnabled };

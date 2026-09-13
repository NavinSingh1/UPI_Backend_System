const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const { getQueueConnection } = require('./connection');
const { processJob } = require('./processors');
const { QUEUE_NAME, moveToDlq } = require('./notificationQueue');

/**
 * Consumes the notification queue.
 *
 * Runs in the standalone worker process (worker.js), NOT in the API replicas —
 * otherwise every replica behind the load balancer would consume jobs, which
 * BullMQ handles safely but which makes concurrency impossible to reason
 * about. `QUEUE_CONCURRENCY` controls how many jobs one worker handles at once.
 */
let worker = null;

const startNotificationWorker = () => {
  if (worker) return worker;

  const connection = getQueueConnection();
  if (!connection) {
    logger.warn('Notification worker not started — REDIS_URL not configured');
    return null;
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job) => processJob(job.name, job.data),
    {
      connection,
      concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
    }
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, jobName: job.name, result }, 'Notification job completed');
  });

  worker.on('failed', async (job, err) => {
    if (!job) {
      logger.error({ err }, 'Notification job failed with no job context');
      return;
    }

    const attemptsAllowed = job.opts?.attempts ?? 1;
    const exhausted = job.attemptsMade >= attemptsAllowed;

    logger.warn(
      { jobId: job.id, jobName: job.name, attempt: job.attemptsMade, of: attemptsAllowed, err: err?.message },
      exhausted ? 'Notification job exhausted retries' : 'Notification job failed, will retry'
    );

    // Only dead-letter once every retry is spent
    if (exhausted) await moveToDlq(job, err);
  });

  worker.on('error', (err) => logger.error({ err }, 'Notification worker error'));

  logger.info({ queue: QUEUE_NAME, concurrency: worker.opts.concurrency }, 'Notification worker started');
  return worker;
};

const stopNotificationWorker = async () => {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Notification worker stopped');
  }
};

module.exports = { startNotificationWorker, stopNotificationWorker };

const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const { getQueueConnection } = require('./connection');
const { processJob } = require('./processors');

const QUEUE_NAME = 'notifications';
const DLQ_NAME = 'notifications-dlq';

/**
 * Durable notification queue.
 *
 * This replaces the previous in-process EventEmitter, which lost every
 * pending notification if the process died between committing a transfer and
 * sending the email. Jobs here survive a restart, retry with exponential
 * backoff, and land in an explicit dead-letter queue once attempts run out.
 *
 * When REDIS_URL isn't configured the queue is unavailable, so enqueue()
 * falls back to running the handler in-process — same behaviour as before,
 * with a warning that durability is off.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: Number(process.env.QUEUE_MAX_ATTEMPTS || 5),
  backoff: {
    type: 'exponential',
    delay: Number(process.env.QUEUE_BACKOFF_MS || 2000), // 2s, 4s, 8s, 16s…
  },
  // Keep a short history for inspection; don't let completed jobs grow forever
  removeOnComplete: { count: 100 },
  // Keep failures around — they're the audit trail for what didn't deliver
  removeOnFail: false,
};

let queue = null;
let dlq = null;

const getQueue = () => {
  if (queue) return queue;

  const connection = getQueueConnection();
  if (!connection) return null;

  queue = new Queue(QUEUE_NAME, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  queue.on('error', (err) => logger.error({ err }, 'Notification queue error'));
  return queue;
};

const getDlq = () => {
  if (dlq) return dlq;

  const connection = getQueueConnection();
  if (!connection) return null;

  dlq = new Queue(DLQ_NAME, { connection });
  dlq.on('error', (err) => logger.error({ err }, 'DLQ error'));
  return dlq;
};

/**
 * Enqueues a job. Returns { queued: true, jobId } when it went to Redis, or
 * { queued: false } when it was handled in-process instead.
 *
 * Never throws: a notification failing must not break the money movement
 * that triggered it.
 */
const enqueue = async (name, data, options = {}) => {
  const q = getQueue();

  if (!q) {
    // In-process fallback — fire and forget, errors logged not thrown
    Promise.resolve()
      .then(() => processJob(name, data))
      .catch((err) => logger.warn({ err, jobName: name }, 'In-process notification failed (no queue configured)'));
    return { queued: false };
  }

  try {
    const job = await q.add(name, data, {
      // Idempotency: a caller-supplied jobId means re-enqueuing the same
      // logical notification is a no-op rather than a duplicate email.
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...options,
    });
    logger.debug({ jobName: name, jobId: job.id }, 'Notification enqueued');
    return { queued: true, jobId: job.id };
  } catch (err) {
    logger.error({ err, jobName: name }, 'Failed to enqueue notification — falling back to in-process');
    Promise.resolve()
      .then(() => processJob(name, data))
      .catch((fallbackErr) => logger.warn({ err: fallbackErr }, 'In-process fallback also failed'));
    return { queued: false };
  }
};

/** Moves a permanently-failed job onto the dead-letter queue for inspection. */
const moveToDlq = async (job, err) => {
  const target = getDlq();
  if (!target) return;

  try {
    await target.add(
      job.name,
      {
        originalJobId: job.id,
        payload: job.data,
        failedReason: err?.message || job.failedReason,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      { removeOnComplete: false, removeOnFail: false }
    );
    logger.error({ jobId: job.id, jobName: job.name, attempts: job.attemptsMade }, 'Job dead-lettered');
  } catch (dlqErr) {
    logger.error({ err: dlqErr, jobId: job.id }, 'Failed to write to DLQ');
  }
};

/** Counts for /health and the admin endpoint. */
const getQueueStats = async () => {
  const q = getQueue();
  if (!q) return { enabled: false, mode: 'in-process', message: 'REDIS_URL not set — jobs are not durable' };

  const [counts, dlqCounts] = await Promise.all([
    q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    getDlq()?.getJobCounts('waiting') ?? Promise.resolve({ waiting: 0 }),
  ]);

  return { enabled: true, mode: 'redis', queue: QUEUE_NAME, counts, deadLettered: dlqCounts.waiting };
};

const closeQueues = async () => {
  await Promise.all([queue?.close(), dlq?.close()].filter(Boolean));
  queue = null;
  dlq = null;
};

module.exports = {
  QUEUE_NAME,
  DLQ_NAME,
  DEFAULT_JOB_OPTIONS,
  getQueue,
  getDlq,
  enqueue,
  moveToDlq,
  getQueueStats,
  closeQueues,
};

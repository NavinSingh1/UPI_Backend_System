/**
 * Real BullMQ + real Redis. The mailer is the only thing mocked, so what's
 * under test is the actual queue behaviour: delivery, retry with backoff,
 * dead-lettering, and jobId deduplication.
 */
jest.mock('../../src/utils/mailer', () => {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'mock-id' });
  sendMail.sendMail = sendMail;
  sendMail.getSmtpBreakerState = () => ({ name: 'smtp', state: 'CLOSED' });
  return sendMail;
});

const sendMail = require('../../src/utils/mailer');
const { enqueue, getQueue, getDlq, getQueueStats, closeQueues } = require('../../src/queues/notificationQueue');
const { startNotificationWorker, stopNotificationWorker } = require('../../src/queues/notificationWorker');
const { closeQueueConnection } = require('../../src/queues/connection');

/** Polls until `predicate` is true or the timeout expires. */
const waitFor = async (predicate, { timeout = 10000, interval = 50 } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
};

let worker;

beforeAll(async () => {
  // Fail loudly rather than silently skipping — a green run must mean the
  // queue was actually exercised.
  const queue = getQueue();
  expect(queue).not.toBeNull();
  await queue.waitUntilReady();

  worker = startNotificationWorker();
  expect(worker).not.toBeNull();
  await worker.waitUntilReady();
});

beforeEach(async () => {
  sendMail.mockClear();
  sendMail.mockResolvedValue({ messageId: 'mock-id' });
  await getQueue().obliterate({ force: true }).catch(() => {});
  await getDlq().obliterate({ force: true }).catch(() => {});
});

afterAll(async () => {
  await stopNotificationWorker();
  await closeQueues();
  await closeQueueConnection();
});

describe('Durable notification queue', () => {
  test('enqueues to Redis (not in-process) and the worker delivers it', async () => {
    const result = await enqueue('otp:send', { email: 'a@example.com', otp: '123456' });

    expect(result.queued).toBe(true);
    expect(result.jobId).toBeDefined();

    const delivered = await waitFor(() => sendMail.mock.calls.length === 1);
    expect(delivered).toBe(true);

    const [args] = sendMail.mock.calls[0];
    expect(args.to).toBe('a@example.com');
    expect(args.text).toContain('123456');
  });

  test('delivers transaction notifications with the amount in rupees', async () => {
    await enqueue('transaction:notify', {
      transactionId: 'txn-1',
      type: 'TRANSFER',
      amountPaise: 25050,
      receiverEmail: 'receiver@example.com',
      receiverName: 'Priya',
    });

    await waitFor(() => sendMail.mock.calls.length === 1);

    const [args] = sendMail.mock.calls[0];
    expect(args.to).toBe('receiver@example.com');
    expect(args.text).toContain('250.5'); // paise converted at the edge
    expect(args.text).not.toContain('25050');
  });

  test('RETRIES a transient failure with backoff, then succeeds', async () => {
    // Fail the first two attempts, succeed on the third
    sendMail
      .mockRejectedValueOnce(new Error('SMTP temporarily unavailable'))
      .mockRejectedValueOnce(new Error('SMTP temporarily unavailable'))
      .mockResolvedValueOnce({ messageId: 'eventually-ok' });

    await enqueue('otp:send', { email: 'retry@example.com', otp: '999999' });

    const succeeded = await waitFor(async () => {
      const counts = await getQueue().getJobCounts('completed');
      return counts.completed === 1;
    });

    expect(succeeded).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(3); // two failures + one success

    // A job that eventually succeeded must NOT be dead-lettered
    const dlqCounts = await getDlq().getJobCounts('waiting');
    expect(dlqCounts.waiting).toBe(0);
  });

  test('DEAD-LETTERS a job once every retry is exhausted', async () => {
    sendMail.mockRejectedValue(new Error('mailbox does not exist'));

    await enqueue('otp:send', { email: 'permanent@example.com', otp: '000000' }, { attempts: 3 });

    const deadLettered = await waitFor(async () => {
      const counts = await getDlq().getJobCounts('waiting');
      return counts.waiting >= 1;
    });

    expect(deadLettered).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(3); // exactly the configured attempts

    const [job] = await getDlq().getJobs(['waiting'], 0, 0);
    expect(job.data.failedReason).toMatch(/mailbox does not exist/);
    expect(job.data.attemptsMade).toBe(3);
    expect(job.data.payload.email).toBe('permanent@example.com');
  });

  test('a failed job is retained for inspection, not silently dropped', async () => {
    sendMail.mockRejectedValue(new Error('hard failure'));

    await enqueue('otp:send', { email: 'kept@example.com', otp: '111111' }, { attempts: 1 });

    await waitFor(async () => (await getQueue().getJobCounts('failed')).failed >= 1);

    const counts = await getQueue().getJobCounts('failed');
    expect(counts.failed).toBe(1); // removeOnFail: false
  });

  test('jobId makes enqueueing idempotent — no duplicate emails', async () => {
    const data = { email: 'dedupe@example.com', otp: '222222' };

    const first = await enqueue('otp:send', data, { jobId: 'otp-dedupe-key' });
    const second = await enqueue('otp:send', data, { jobId: 'otp-dedupe-key' });

    expect(first.jobId).toBe('otp-dedupe-key');
    expect(second.jobId).toBe('otp-dedupe-key');

    await waitFor(() => sendMail.mock.calls.length >= 1);
    // Give the worker a beat to (not) process a second copy
    await new Promise((r) => setTimeout(r, 300));

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('an unknown job name is dropped without retrying forever', async () => {
    await enqueue('nonexistent:job', { foo: 'bar' });

    await waitFor(async () => (await getQueue().getJobCounts('completed')).completed >= 1);

    expect(sendMail).not.toHaveBeenCalled();
    const dlqCounts = await getDlq().getJobCounts('waiting');
    expect(dlqCounts.waiting).toBe(0);
  });

  test('survives a worker restart — the job is still there afterwards', async () => {
    // Stop consuming, enqueue, then bring the consumer back. This is the
    // durability property the old EventEmitter did not have.
    await stopNotificationWorker();

    await enqueue('otp:send', { email: 'durable@example.com', otp: '333333' });
    expect((await getQueue().getJobCounts('waiting')).waiting).toBe(1);

    worker = startNotificationWorker();
    await worker.waitUntilReady();

    const delivered = await waitFor(() => sendMail.mock.calls.length === 1);
    expect(delivered).toBe(true);
  });

  test('getQueueStats reports depth and dead-letter count', async () => {
    const stats = await getQueueStats();

    expect(stats.enabled).toBe(true);
    expect(stats.mode).toBe('redis');
    expect(stats.counts).toHaveProperty('waiting');
    expect(stats.counts).toHaveProperty('failed');
    expect(stats).toHaveProperty('deadLettered');
  });
});

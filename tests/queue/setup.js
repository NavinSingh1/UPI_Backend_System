/**
 * Queue tests run the real BullMQ pipeline against a real Redis — no mocks
 * of the queue itself, because the whole point is verifying that retries,
 * backoff and dead-lettering actually work.
 *
 * They need REDIS_URL and nothing else (no MongoDB). Start one locally with:
 *   redis-server --port 6379 --daemonize yes
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Short backoff so retry behaviour is testable in seconds, not minutes
process.env.QUEUE_BACKOFF_MS = process.env.QUEUE_BACKOFF_MS || '50';

jest.setTimeout(30000);

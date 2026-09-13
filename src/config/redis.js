const Redis = require('ioredis');

// Redis is OPTIONAL for this project. If REDIS_URL isn't set, we simply run
// without it — src/utils/cache.js falls back to an in-memory store so caching,
// the JWT blacklist, OTP storage and idempotency keys all keep working.
let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    // Don't let a down/unreachable Redis hang requests or crash the process —
    // fail fast per-command and let cache.js fall back to memory instead.
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
    lazyConnect: false,
  });

  redisClient.on('connect', () => {
    console.log('✅ Redis connected — caching, blacklist & idempotency backed by Redis');
  });

  redisClient.on('error', (err) => {
    // Swallow the error here (don't crash) — cache.js checks redisClient.status
    // before every operation and transparently uses its in-memory fallback.
    console.warn(`⚠️  Redis error (falling back to in-memory store): ${err.message}`);
  });
} else {
  console.log('ℹ️  REDIS_URL not set — running without Redis (using in-memory fallback for caching/blacklist/OTP/idempotency)');
}

module.exports = redisClient;

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../config/redis');

/**
 * Phase 1.2 + 5.5 — builds a rate limiter with a consistent JSON error body.
 * When Redis is configured (and connected), counters are stored there so
 * they survive server restarts across multiple instances. Otherwise
 * express-rate-limit's default in-memory store is used automatically —
 * still effective for a single dev/small deployment.
 */
const buildLimiter = (windowMs, max, message) => {
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
  };

  if (redisClient) {
    options.store = new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    });
  }

  return rateLimit(options);
};

module.exports = {
  // POST /api/auth/login — stop brute-force on passwords
  loginLimiter: buildLimiter(15 * 60 * 1000, 5, 'Too many login attempts. Please try again in 15 minutes.'),
  // POST /api/auth/setup-mpin — stop brute-force on MPIN
  mpinLimiter: buildLimiter(60 * 60 * 1000, 5, 'Too many MPIN attempts. Please try again in 1 hour.'),
  // POST /api/transactions/send — prevent transaction spam
  sendMoneyLimiter: buildLimiter(10 * 60 * 1000, 20, 'Too many transaction attempts. Please slow down.'),
  // POST /api/auth/register — prevent fake account creation
  registerLimiter: buildLimiter(60 * 60 * 1000, 10, 'Too many accounts created from this IP. Try again later.'),
  // Applied globally in src/app.js — general API protection
  globalLimiter: buildLimiter(15 * 60 * 1000, 100, 'Too many requests. Please try again later.'),
};

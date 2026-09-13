const redisClient = require('../config/redis');

/**
 * In-memory fallback store, used whenever Redis isn't configured or is
 * momentarily unreachable. Not shared across processes/instances and cleared
 * on restart — perfectly fine for a single dev/small deployment, and it's
 * what lets every feature that depends on caching (blacklist, OTP,
 * idempotency, response caching) keep working with zero Redis setup.
 */
const memoryStore = new Map();

const isRedisUp = () => !!redisClient && redisClient.status === 'ready';

const memGet = (key) => {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
};

const memSet = (key, value, ttlSeconds) => {
  memoryStore.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
};

const getCache = async (key) => {
  if (isRedisUp()) {
    try {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn(`Cache GET failed for "${key}", falling back to memory: ${err.message}`);
    }
  }
  return memGet(key);
};

const setCache = async (key, data, ttlSeconds = 300) => {
  if (isRedisUp()) {
    try {
      if (ttlSeconds) {
        await redisClient.set(key, JSON.stringify(data), 'EX', ttlSeconds);
      } else {
        await redisClient.set(key, JSON.stringify(data));
      }
      return;
    } catch (err) {
      console.warn(`Cache SET failed for "${key}", falling back to memory: ${err.message}`);
    }
  }
  memSet(key, data, ttlSeconds);
};

const deleteCache = async (key) => {
  if (isRedisUp()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.warn(`Cache DEL failed for "${key}": ${err.message}`);
    }
  }
  memoryStore.delete(key);
};

/**
 * Deletes every key starting with `prefix` — used to invalidate all cached
 * pagination/filter variants of a list (e.g. every cached page of one user's
 * transaction history) in one call.
 */
const deleteCacheByPrefix = async (prefix) => {
  if (isRedisUp()) {
    try {
      const keys = await redisClient.keys(`${prefix}*`);
      if (keys.length) await redisClient.del(keys);
    } catch (err) {
      console.warn(`Cache prefix DEL failed for "${prefix}": ${err.message}`);
    }
  }
  for (const key of memoryStore.keys()) {
    if (key.startsWith(prefix)) memoryStore.delete(key);
  }
};

module.exports = { getCache, setCache, deleteCache, deleteCacheByPrefix };

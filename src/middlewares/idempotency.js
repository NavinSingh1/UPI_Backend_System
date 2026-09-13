const { getCache, setCache } = require('../utils/cache');

/**
 * Phase 5.1 — Idempotency Keys.
 * Optional: a client sends an `Idempotency-Key` header on POST /txn/send.
 * If the same key is seen again for the same user (e.g. a client retry
 * after a timeout, or a double-tap on "Send"), the original response is
 * replayed instead of re-running the transfer — preventing double-charges.
 * Must run AFTER `protect` (needs req.user).
 */
const idempotency = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // No key supplied — proceed normally, nothing to dedupe against

  const cacheKey = `idempotency:${req.user._id}:${key}`;
  const cached = await getCache(cacheKey);

  if (cached) {
    return res.status(cached.status).json({ ...cached.body, idempotent: true });
  }

  // Intercept res.json so we can store whatever the route eventually responds with
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      // Keep for 24h — long enough to cover realistic client retry windows
      setCache(cacheKey, { status: res.statusCode, body }, 24 * 60 * 60).catch(() => {});
    }
    return originalJson(body);
  };

  next();
};

module.exports = idempotency;

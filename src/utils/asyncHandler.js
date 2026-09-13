/**
 * Wraps an async route/middleware handler so any thrown error or rejected
 * promise is forwarded to Express's centralized error handler (next(err))
 * instead of needing a try/catch in every controller, and instead of
 * crashing the process on an unhandled rejection.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;

const logger = require('../utils/logger');

/**
 * Centralized error handler. Everything asyncHandler catches from a
 * controller, plus anything thrown in middleware, lands here instead of
 * crashing the process or leaking a stack trace to the client.
 * Must be registered LAST, after all routes.
 */
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;

  // req.log carries the request's correlation id (see requestLogger)
  const log = req.log || logger;
  const payload = { err, statusCode, path: req.originalUrl, method: req.method };

  if (statusCode >= 500) log.error(payload, 'Unhandled request error');
  else log.warn(payload, 'Request failed');

  // Mongo duplicate-key errors are a client problem, not a server one
  if (err.code === 11000) {
    return res.status(409).json({
      message: 'That record already exists',
      ...(process.env.NODE_ENV === 'development' && { keyValue: err.keyValue }),
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      message: 'Validation failed',
      errors: Object.values(err.errors || {}).map((e) => e.message),
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: `Invalid ${err.path}: ${err.value}` });
  }

  res.status(statusCode).json({
    message: err.message || 'Something went wrong on our end',
    ...(req.id ? { requestId: req.id } : {}),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/** Catches requests to routes that don't exist and returns a clean 404. */
const notFound = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

module.exports = { errorHandler, notFound };

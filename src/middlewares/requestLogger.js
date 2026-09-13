const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

/**
 * Phase: structured logging + correlation IDs.
 * Every request gets an X-Request-Id (reusing the caller's if it sent one),
 * echoed back on the response and attached to every log line for that
 * request via req.log — so you can trace one payment across the whole log.
 */
const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = existing || randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
});

module.exports = requestLogger;

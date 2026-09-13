const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Structured JSON logging. In production this emits one JSON object per line
 * (parseable by any log aggregator); in development it's pretty-printed.
 * Tests stay silent unless LOG_LEVEL says otherwise.
 *
 * `redact` keeps secrets out of logs — an MPIN or password landing in a log
 * file is as bad as storing it in plaintext.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.oldPassword',
      'req.body.mpin',
      'req.body.otp',
      'password',
      'mpin',
      'otp',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

module.exports = logger;

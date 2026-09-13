const nodemailer = require('nodemailer');
const logger = require('./logger');
const { getBreaker } = require('./circuitBreaker');

let transporter = null;

/**
 * SMTP is the classic circuit-breaker candidate: it's external, it's slow when
 * unhealthy, and a queue of requests each waiting 10s on a dead mail server
 * will exhaust the process long before the mail server recovers. After 3
 * consecutive failures we stop calling it for 60s and fail fast instead.
 */
const smtpBreaker = getBreaker('smtp', {
  failureThreshold: Number(process.env.SMTP_BREAKER_FAILURES || 3),
  resetTimeoutMs: Number(process.env.SMTP_BREAKER_RESET_MS || 60000),
  successThreshold: 1,
  timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 10000),
  onStateChange: ({ from, to }) => logger.warn({ circuit: 'smtp', from, to }, 'SMTP circuit breaker changed state'),
});

const getTransporter = () => {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in .env (see .env.example).'
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465, // true for 465, false for 587/25 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10000),
  });

  return transporter;
};

/**
 * Sends an email through the SMTP circuit breaker.
 *
 * Throws if SMTP isn't configured, if the breaker is open, or if delivery
 * fails. Callers on a core flow (password reset) should surface the error;
 * callers on a best-effort flow go through the notification queue, which
 * retries with backoff and eventually dead-letters.
 */
const sendMail = async ({ to, subject, text, html }) => {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  return smtpBreaker.execute(async () => {
    const info = await getTransporter().sendMail({ from, to, subject, text, html });
    logger.debug({ to, subject, messageId: info?.messageId }, 'Email sent');
    return info;
  });
};

/** Exposed so /health and the admin route can report breaker state. */
const getSmtpBreakerState = () => smtpBreaker.getState();

module.exports = sendMail;
module.exports.sendMail = sendMail;
module.exports.getSmtpBreakerState = getSmtpBreakerState;
module.exports.smtpBreaker = smtpBreaker;

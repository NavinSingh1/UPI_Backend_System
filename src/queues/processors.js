const logger = require('../utils/logger');
const sendMail = require('../utils/mailer');
const { paiseToRupees } = require('../utils/money');

/**
 * Job handlers, kept free of any BullMQ types so they can be called directly
 * by the in-process fallback and unit-tested without Redis.
 *
 * A handler that throws signals a retryable failure — BullMQ will re-attempt
 * with exponential backoff and, once attempts are exhausted, move the job to
 * the dead-letter queue. Anything genuinely unrecoverable should be logged
 * and returned normally so it isn't retried pointlessly.
 */
const handlers = {
  /** Notify the receiver of an incoming payment. */
  'transaction:notify': async (data) => {
    const { receiverEmail, receiverName, amountPaise, transactionId, type } = data;

    if (!receiverEmail) {
      logger.debug({ transactionId }, 'transaction:notify skipped — no receiver email');
      return { skipped: 'no-email' };
    }

    await sendMail({
      to: receiverEmail,
      subject: 'You received money on PhonePe Clone',
      text: `Hi ${receiverName || 'there'}, you just received ₹${paiseToRupees(amountPaise)} (${type}). Transaction: ${transactionId}`,
    });

    return { delivered: true, to: receiverEmail };
  },

  /** Deliver a password-reset OTP. */
  'otp:send': async (data) => {
    const { email, otp } = data;

    await sendMail({
      to: email,
      subject: 'Your PhonePe Clone password reset OTP',
      text: `Your OTP is ${otp}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    });

    return { delivered: true, to: email };
  },
};

/** Dispatches a job by name. Unknown names are a programming error, not a retry case. */
const processJob = async (name, data) => {
  const handler = handlers[name];
  if (!handler) {
    logger.error({ jobName: name }, 'No handler registered for job — dropping');
    return { skipped: 'no-handler' };
  }
  return handler(data);
};

module.exports = { handlers, processJob, JOB_NAMES: Object.keys(handlers) };

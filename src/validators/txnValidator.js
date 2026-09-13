const Joi = require('joi');
const { rupeesToPaise } = require('../utils/money');

/**
 * A rupee amount. Accepts a number or a string, rejects anything with more
 * than 2 decimal places, and rejects zero/negative — the same parsing the
 * money layer uses, so a request can never reach a controller with an
 * amount the ledger would refuse.
 */
const amountRupees = Joi.alternatives()
  .try(Joi.number(), Joi.string())
  .required()
  .custom((value, helpers) => {
    try {
      const paise = rupeesToPaise(value);
      if (paise <= 0) return helpers.message('Amount must be greater than zero');
      return value;
    } catch (err) {
      return helpers.message(err.message);
    }
  });

const mpin = Joi.string()
  .pattern(/^\d{4,6}$/)
  .required()
  .messages({ 'string.pattern.base': 'MPIN must be 4-6 digits' });

const sendMoneySchema = Joi.object({
  receiverIdentifier: Joi.string().required(),
  amount: amountRupees,
  mpin,
  note: Joi.string().max(140),
});

const addMoneySchema = Joi.object({
  amount: amountRupees,
});

const payBillSchema = Joi.object({
  billerName: Joi.string().min(2).required(),
  amount: amountRupees,
  mpin,
});

const withdrawSchema = Joi.object({
  amount: amountRupees,
  mpin,
});

const refundSchema = Joi.object({
  // Omit to refund the full remaining amount
  amount: Joi.alternatives().try(Joi.number(), Joi.string()).custom((value, helpers) => {
    try {
      if (rupeesToPaise(value) <= 0) return helpers.message('Refund amount must be greater than zero');
      return value;
    } catch (err) {
      return helpers.message(err.message);
    }
  }),
  mpin,
});

const categorySchema = Joi.object({
  category: Joi.string()
    .valid('TRANSFER', 'FOOD', 'TRAVEL', 'BILLS', 'SHOPPING', 'ENTERTAINMENT', 'RECHARGE', 'OTHER')
    .required(),
});

const paymentRequestSchema = Joi.object({
  payerIdentifier: Joi.string().required(), // phone or UPI ID
  amount: amountRupees,
  note: Joi.string().max(140),
  expiresInHours: Joi.number().integer().min(1).max(720).default(72),
});

const respondToRequestSchema = Joi.object({
  mpin, // required only when accepting; the route enforces which is needed
});

const splitBillSchema = Joi.object({
  description: Joi.string().min(2).max(140).required(),
  amount: amountRupees,
  participantIdentifiers: Joi.array().items(Joi.string()).min(1).max(20).required().messages({
    'array.min': 'Add at least one other participant to split with',
  }),
  includeSelf: Joi.boolean().default(true),
});

const recurringSchema = Joi.object({
  payeeIdentifier: Joi.string().required(),
  amount: amountRupees,
  frequency: Joi.string().valid('DAILY', 'WEEKLY', 'MONTHLY').required(),
  note: Joi.string().max(140),
  startAt: Joi.date().iso().min('now'),
  mpin, // authorizes the mandate at creation time; never stored
});

module.exports = {
  amountRupees,
  sendMoneySchema,
  addMoneySchema,
  payBillSchema,
  withdrawSchema,
  refundSchema,
  categorySchema,
  paymentRequestSchema,
  respondToRequestSchema,
  splitBillSchema,
  recurringSchema,
};

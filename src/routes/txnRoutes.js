const express = require('express');
const router = express.Router();
const {
  sendMoney,
  getTransactionHistory,
  getTransactionSummary,
  getSpendingAnalytics,
  downloadStatement,
  getTransactionById,
  updateTransactionCategory,
  refundTransaction,
} = require('../controllers/txnController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const verifyMpin = require('../middlewares/verifyMpin');
const idempotency = require('../middlewares/idempotency');
const { enforceTransactionLimits } = require('../middlewares/enforceLimits');
const { sendMoneyLimiter } = require('../middlewares/rateLimiter');
const { sendMoneySchema, refundSchema, categorySchema } = require('../validators/txnValidator');

// Middleware order matters: validate the body, verify the MPIN, check
// spending limits, then dedupe retries, then move money.
router.post(
  '/send',
  protect,
  sendMoneyLimiter,
  validate(sendMoneySchema),
  verifyMpin,
  enforceTransactionLimits,
  idempotency,
  sendMoney
);

// NOTE: literal paths must be registered BEFORE '/:txnId', otherwise Express
// would match them as a transaction id.
router.get('/history', protect, getTransactionHistory);
router.get('/summary', protect, getTransactionSummary);
router.get('/analytics', protect, getSpendingAnalytics);
router.get('/statement', protect, downloadStatement);

router.get('/:txnId', protect, getTransactionById);
router.patch('/:txnId/category', protect, validate(categorySchema), updateTransactionCategory);
router.post('/:txnId/refund', protect, validate(refundSchema), verifyMpin, idempotency, refundTransaction);

module.exports = router;

const express = require('express');
const router = express.Router();
const {
  getBalance,
  getLimits,
  addMoney,
  payBill,
  withdraw,
  miniStatement,
  reconcile,
} = require('../controllers/walletController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const verifyMpin = require('../middlewares/verifyMpin');
const idempotency = require('../middlewares/idempotency');
const { enforceTransactionLimits } = require('../middlewares/enforceLimits');
const { addMoneySchema, payBillSchema, withdrawSchema } = require('../validators/txnValidator');

router.get('/balance', protect, getBalance);
router.get('/limits', protect, getLimits);
router.get('/mini-statement', protect, miniStatement);
router.get('/reconcile', protect, reconcile);

router.post('/add-money', protect, validate(addMoneySchema), idempotency, addMoney);
router.post(
  '/pay-bill',
  protect,
  validate(payBillSchema),
  verifyMpin,
  enforceTransactionLimits,
  idempotency,
  payBill
);
router.post(
  '/withdraw',
  protect,
  validate(withdrawSchema),
  verifyMpin,
  enforceTransactionLimits,
  idempotency,
  withdraw
);

module.exports = router;

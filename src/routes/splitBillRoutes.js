const express = require('express');
const router = express.Router();
const {
  createSplitBill,
  listSplitBills,
  getSplitBill,
  settleMyShare,
} = require('../controllers/splitBillController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const verifyMpin = require('../middlewares/verifyMpin');
const idempotency = require('../middlewares/idempotency');
const { splitBillSchema, respondToRequestSchema } = require('../validators/txnValidator');

router.post('/', protect, validate(splitBillSchema), createSplitBill);
router.get('/', protect, listSplitBills);
router.get('/:id', protect, getSplitBill);
router.post('/:id/settle', protect, validate(respondToRequestSchema), verifyMpin, idempotency, settleMyShare);

module.exports = router;

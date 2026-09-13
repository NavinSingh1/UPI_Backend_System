const express = require('express');
const router = express.Router();
const {
  createPaymentRequest,
  listPaymentRequests,
  acceptPaymentRequest,
  declinePaymentRequest,
  cancelPaymentRequest,
} = require('../controllers/paymentRequestController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const verifyMpin = require('../middlewares/verifyMpin');
const idempotency = require('../middlewares/idempotency');
const { paymentRequestSchema, respondToRequestSchema } = require('../validators/txnValidator');

router.post('/', protect, validate(paymentRequestSchema), createPaymentRequest);
router.get('/', protect, listPaymentRequests);

// Accepting moves money, so it needs the MPIN
router.post('/:id/accept', protect, validate(respondToRequestSchema), verifyMpin, idempotency, acceptPaymentRequest);
router.post('/:id/decline', protect, declinePaymentRequest);
router.post('/:id/cancel', protect, cancelPaymentRequest);

module.exports = router;

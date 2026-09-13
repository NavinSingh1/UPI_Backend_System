const express = require('express');
const router = express.Router();
const {
  createMandate,
  listMandates,
  pauseMandate,
  resumeMandate,
  cancelMandate,
} = require('../controllers/recurringController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const verifyMpin = require('../middlewares/verifyMpin');
const { recurringSchema } = require('../validators/txnValidator');

// The MPIN check here IS the mandate's authorization — it is never stored,
// and later automatic runs happen without it.
router.post('/', protect, validate(recurringSchema), verifyMpin, createMandate);
router.get('/', protect, listMandates);
router.post('/:id/pause', protect, pauseMandate);
router.post('/:id/resume', protect, resumeMandate);
router.delete('/:id', protect, cancelMandate);

module.exports = router;

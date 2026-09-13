const express = require('express');
const router = express.Router();
const { searchUserByUpi, getMyQrCode, parseQrCode } = require('../controllers/userController');
const { protect } = require('../middlewares/authMiddleware');

router.get('/search', protect, searchUserByUpi);
router.get('/me/qr', protect, getMyQrCode);
router.post('/parse-qr', protect, parseQrCode);

module.exports = router;

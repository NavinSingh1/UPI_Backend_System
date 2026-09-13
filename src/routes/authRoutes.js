const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  getUserProfile,
  setupMpin,
  logoutUser,
  changePassword,
  updateProfile,
  forgotPassword,
  resetPassword,
  deactivateAccount,
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');
const { loginLimiter, mpinLimiter, registerLimiter } = require('../middlewares/rateLimiter');
const {
  registerSchema,
  loginSchema,
  mpinSchema,
  changePasswordSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require('../validators/authValidator');

router.post('/register', registerLimiter, validate(registerSchema), registerUser);
router.post('/login', loginLimiter, validate(loginSchema), loginUser);
router.get('/profile', protect, getUserProfile);
router.post('/setup-mpin', protect, mpinLimiter, validate(mpinSchema), setupMpin);

// New Routes
router.post('/logout', protect, logoutUser);
router.put('/change-password', protect, validate(changePasswordSchema), changePassword);
router.put('/update-profile', protect, validate(updateProfileSchema), updateProfile);
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);
router.delete('/account', protect, deactivateAccount);

module.exports = router;

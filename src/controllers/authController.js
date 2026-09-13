const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { enqueue } = require('../queues/notificationQueue');
const { getCache, setCache, deleteCache } = require('../utils/cache');
const { postTransaction } = require('../services/ledgerService');
const { rupeesToPaise } = require('../utils/money');
const { serializeUser } = require('../utils/serializers');
const { clearFailures } = require('../utils/mpinLockout');

/** Every new wallet starts with this much, credited through the ledger. */
const OPENING_BALANCE_PAISE = rupeesToPaise(process.env.OPENING_BALANCE_RUPEES || '1000');

// Generate JWT Helper
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

// Blacklists the bearer token on the current request until it would have
// naturally expired. Shared by logout and account deactivation.
const blacklistCurrentToken = async (req) => {
  const token = req.headers.authorization.split(' ')[1];
  const decoded = jwt.decode(token);
  const ttl = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 30 * 24 * 60 * 60;
  await setCache(`blacklist:${token}`, true, ttl > 0 ? ttl : 1);
};

const registerUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;

  const userExists = await User.findOne({ $or: [{ email }, { phone }] });
  if (userExists) {
    return res.status(400).json({ message: 'User with this email or phone already exists' });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  // Dynamic UPI Generation (Example: amit954@phonepe)
  const sanitizedName = name.replace(/\s/g, '').toLowerCase();
  const upiId = `${sanitizedName}${Math.floor(Math.random() * 10000)}@phonepe`;

  const user = await User.create({
    name,
    email,
    phone,
    password: hashedPassword,
    upiId,
    balancePaise: 0, // credited below, through the ledger
  });

  // The opening balance is posted as a real ledger transaction rather than
  // written straight onto the user, so every paise in the system is
  // traceable to a balanced entry and reconciliation stays meaningful.
  if (OPENING_BALANCE_PAISE > 0) {
    try {
      await postTransaction({
        type: 'ADD_MONEY',
        amountPaise: OPENING_BALANCE_PAISE,
        toUserId: user._id,
        billerName: 'Opening balance',
      });
    } catch (err) {
      // A failed bonus shouldn't block signup — the account is valid at ₹0.
      logger.error({ err, userId: String(user._id) }, 'Failed to credit opening balance');
    }
  }

  const fresh = await User.findById(user._id);

  res.status(201).json({
    ...serializeUser(fresh),
    hasMpinSet: false,
    token: generateToken(user._id),
  });
});

const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  // Phase 5.4 — deactivated accounts can't log back in
  if (user.isActive === false) {
    return res.status(403).json({ message: 'This account has been deactivated' });
  }

  res.json({
    ...serializeUser(user),
    hasMpinSet: !!user.mpin,
    token: generateToken(user._id),
  });
});

// @desc    Get logged-in user's profile (Redis/memory cached)
// @route   GET /api/auth/profile
// @access  Private
const getUserProfile = asyncHandler(async (req, res) => {
  const cacheKey = `user:profile:${req.user._id}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const user = await User.findById(req.user._id).select('-password -mpin');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const responseUser = serializeUser(user);
  responseUser.hasMpinSet = !!req.user.mpin;

  await setCache(cacheKey, responseUser, 600); // 10 min
  res.json(responseUser);
});

// @desc    Set or Change 4-6 digit MPIN
// @route   POST /api/auth/setup-mpin
// @access  Private
const setupMpin = asyncHandler(async (req, res) => {
  const { mpin } = req.body;

  const salt = await bcrypt.genSalt(10);
  const hashedMpin = await bcrypt.hash(mpin.toString(), salt);

  const user = await User.findById(req.user._id);
  user.mpin = hashedMpin;
  await user.save();

  await deleteCache(`user:profile:${user._id}`); // hasMpinSet just changed
  await clearFailures(user._id); // a fresh MPIN clears any lockout

  res.json({ message: 'MPIN setup successfully!' });
});

// @desc    Blacklist the current JWT so it can't be reused
// @route   POST /api/auth/logout
// @access  Private
const logoutUser = asyncHandler(async (req, res) => {
  await blacklistCurrentToken(req);
  res.json({ message: 'Logged out successfully' });
});

// @desc    Change password (requires current password)
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id);

  const isMatch = await bcrypt.compare(oldPassword, user.password);
  if (!isMatch) {
    return res.status(401).json({ message: 'Old password is incorrect' });
  }

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(newPassword, salt);
  await user.save();

  res.json({ message: 'Password changed successfully' });
});

// @desc    Update name and/or phone number
// @route   PUT /api/auth/update-profile
// @access  Private
const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  const user = await User.findById(req.user._id);

  if (phone && phone !== user.phone) {
    const phoneTaken = await User.findOne({ phone, _id: { $ne: user._id } });
    if (phoneTaken) {
      return res.status(400).json({ message: 'This phone number is already in use' });
    }
    user.phone = phone;
  }

  if (name) user.name = name;

  await user.save();
  await deleteCache(`user:profile:${user._id}`);

  res.json(serializeUser(user));
});

// @desc    Generate a 6-digit OTP and email it to the account's address
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Respond identically whether or not the email is registered, so this
  // endpoint can't be used to enumerate valid accounts.
  if (user) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await setCache(`otp:${email}`, otp, 600); // 10 min expiry

    // Queued rather than sent inline: the OTP survives a transient SMTP
    // outage (retries with backoff) and the request isn't held open waiting
    // on a mail server.
    await enqueue('otp:send', { email, otp });
  }

  res.json({ message: 'If an account with that email exists, an OTP has been sent to it.' });
});

// @desc    Verify OTP and set a new password
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  const storedOtp = await getCache(`otp:${email}`);
  if (!storedOtp || storedOtp !== otp) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(newPassword, salt);
  await user.save();
  await deleteCache(`otp:${email}`);

  res.json({ message: 'Password reset successful. Please login with your new password.' });
});

// @desc    Soft-delete (deactivate) the logged-in account
// @route   DELETE /api/auth/account
// @access  Private
const deactivateAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  user.isActive = false;
  await user.save();

  await blacklistCurrentToken(req); // force logout on the token that just deactivated it
  await deleteCache(`user:profile:${user._id}`);

  res.json({ message: 'Account deactivated successfully' });
});

module.exports = {
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
};

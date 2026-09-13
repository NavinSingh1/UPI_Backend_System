const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { getCache } = require('../utils/cache');

const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  // Phase 3 — reject tokens that were explicitly logged out (blacklisted in Redis/memory)
  const isBlacklisted = await getCache(`blacklist:${token}`);
  if (isBlacklisted) {
    return res.status(401).json({ message: 'Session expired, please login again' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  const user = await User.findById(decoded.id).select('-password');
  if (!user) {
    return res.status(401).json({ message: 'Not authorized, user no longer exists' });
  }

  // Phase 5.4 — deactivated (soft-deleted) accounts can no longer authenticate
  if (user.isActive === false) {
    return res.status(401).json({ message: 'This account has been deactivated' });
  }

  req.user = user;
  next();
});

module.exports = { protect };

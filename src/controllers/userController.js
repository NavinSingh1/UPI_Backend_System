const QRCode = require('qrcode');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { getCache, setCache } = require('../utils/cache');
const { paiseToRupees, rupeesToPaise } = require('../utils/money');
const { buildUpiUri, parseUpiUri } = require('../utils/upi');

// @desc    Find a user by their UPI ID (so senders can confirm before paying)
// @route   GET /api/users/search?upiId=amit123@phonepe
// @access  Private
const searchUserByUpi = asyncHandler(async (req, res) => {
  const { upiId } = req.query;
  if (!upiId) {
    return res.status(400).json({ message: 'upiId query parameter is required' });
  }

  const cacheKey = `upi:${upiId}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const user = await User.findOne({ upiId, isActive: { $ne: false } }).select('name upiId phone');
  if (!user) {
    return res.status(404).json({ message: 'No user found with this UPI ID' });
  }

  const payload = { _id: user._id, name: user.name, upiId: user.upiId, phone: user.phone };
  await setCache(cacheKey, payload, 900);
  res.json(payload);
});

// @desc    My payment QR code (optionally pre-filled with an amount)
// @route   GET /api/users/me/qr?amount=250&format=png|dataurl|svg
// @access  Private
const getMyQrCode = asyncHandler(async (req, res) => {
  const { amount, format = 'dataurl' } = req.query;

  const amountPaise = amount ? rupeesToPaise(amount) : undefined;
  const uri = buildUpiUri({
    upiId: req.user.upiId,
    name: req.user.name,
    amountPaise,
  });

  if (format === 'png') {
    const buffer = await QRCode.toBuffer(uri, { type: 'png', width: 512, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${req.user.upiId}.png"`);
    return res.send(buffer);
  }

  if (format === 'svg') {
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 2 });
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  }

  const dataUrl = await QRCode.toDataURL(uri, { width: 512, margin: 2 });
  return res.json({
    upiId: req.user.upiId,
    name: req.user.name,
    ...(amountPaise ? { amount: paiseToRupees(amountPaise), amountPaise } : {}),
    uri,
    qrDataUrl: dataUrl,
  });
});

// @desc    Turn a scanned QR string into a resolved payee
// @route   POST /api/users/parse-qr   body: { uri }
// @access  Private
const parseQrCode = asyncHandler(async (req, res) => {
  const { uri } = req.body;
  if (!uri) return res.status(400).json({ message: 'uri is required' });

  let parsed;
  try {
    parsed = parseUpiUri(uri);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }

  const user = await User.findOne({ upiId: parsed.upiId, isActive: { $ne: false } }).select('name upiId phone');
  if (!user) {
    return res.status(404).json({ message: 'That QR code does not match any active account' });
  }

  res.json({
    payee: { _id: user._id, name: user.name, upiId: user.upiId },
    ...(parsed.amountPaise
      ? { amount: paiseToRupees(parsed.amountPaise), amountPaise: parsed.amountPaise }
      : {}),
    note: parsed.note,
  });
});

module.exports = { searchUserByUpi, getMyQrCode, parseQrCode };

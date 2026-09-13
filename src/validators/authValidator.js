const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  phone: Joi.string()
    .pattern(/^\d{10}$/)
    .required()
    .messages({ 'string.pattern.base': 'Phone number must be exactly 10 digits' }),
  password: Joi.string().min(8).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

// Kept at 4-6 digits (not strictly 6) so the project's existing 4-digit seed
// data (MPIN "1234") stays valid — see seed.js.
const mpinSchema = Joi.object({
  mpin: Joi.string()
    .pattern(/^\d{4,6}$/)
    .required()
    .messages({ 'string.pattern.base': 'MPIN must be 4-6 digits' }),
});

const changePasswordSchema = Joi.object({
  oldPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

const updateProfileSchema = Joi.object({
  name: Joi.string().min(2).max(50),
  phone: Joi.string().pattern(/^\d{10}$/),
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update (name or phone)' });

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).required(),
  newPassword: Joi.string().min(8).required(),
});

module.exports = {
  registerSchema,
  loginSchema,
  mpinSchema,
  changePasswordSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};

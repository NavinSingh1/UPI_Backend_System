/**
 * Phase 1.3 — Input validation.
 * Returns a middleware that validates req.body against a Joi schema.
 * On failure, responds 400 with every violation instead of letting bad
 * data reach a controller (and possibly the database).
 */
const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: error.details.map((d) => d.message),
    });
  }

  req.body = value;
  next();
};

module.exports = validate;

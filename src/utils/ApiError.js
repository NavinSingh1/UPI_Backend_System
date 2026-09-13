/**
 * An error carrying an HTTP status code. The centralized error handler
 * (middlewares/errorHandler.js) reads `statusCode`, so services can throw
 * meaningful failures without knowing anything about Express.
 */
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message) {
    return new ApiError(400, message);
  }

  static unauthorized(message) {
    return new ApiError(401, message);
  }

  static forbidden(message) {
    return new ApiError(403, message);
  }

  static notFound(message) {
    return new ApiError(404, message);
  }

  static conflict(message) {
    return new ApiError(409, message);
  }

  static tooManyRequests(message) {
    return new ApiError(429, message);
  }
}

module.exports = ApiError;

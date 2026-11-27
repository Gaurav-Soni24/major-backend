// Operational error with an HTTP status and a machine-readable code (see API_CONTRACT.md).
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.isAppError = true;
  }
}

const E = {
  validation: (message = 'Validation failed', details) => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthenticated: (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'Conflict') => new AppError(409, 'CONFLICT', message),
};

module.exports = { AppError, E };

const { AppError } = require('../utils/AppError');

const notFoundHandler = (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found'));

// One error handler: never leaks stack traces or internal messages.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return;

  let status = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong on our side. Please try again.';
  let details;

  if (err && err.isAppError) {
    ({ status, code, message, details } = err);
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large.';
  } else if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request body is not valid JSON.';
  } else if (err && err.name === 'ValidationError' && err.errors) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: 'Invalid value' }));
  } else if (err && err.name === 'CastError') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid identifier or value.';
  } else if (err && (err.code === 11000 || err.code === 11001)) {
    status = 409;
    code = 'CONFLICT';
    message = 'This record already exists.';
  } else {
    // Unknown: log everything server-side, say nothing to the client.
    console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  }

  const body = { success: false, code, message };
  if (details && details.length) body.details = details;
  res.status(status).json(body);
};

module.exports = { errorHandler, notFoundHandler };

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const passthrough = (req, res, next) => next();

const handler = (req, res) => {
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again later.' });
};

const MIN = 60 * 1000;

const ipKey = (req) => ipKeyGenerator(req.ip || '');
const attemptKey = (req) => {
  const t = req.get('x-attempt-token');
  return t ? `attempt:${String(t).slice(0, 128)}` : `ip:${ipKey(req)}`;
};
const teacherKey = (req) => (req.user && req.user.userId ? `teacher:${req.user.userId}` : `ip:${ipKey(req)}`);

/**
 * Builds the set of limiters (contract: API_CONTRACT.md "Rate limits"). Each call creates fresh
 * in-memory stores. With `enabled: false` every limiter is a no-op (used by tests).
 */
const createLimiters = ({ enabled = true } = {}) => {
  const make = (windowMs, limit, keyGenerator = ipKey) =>
    enabled
      ? rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator, handler, validate: false })
      : passthrough;
  return {
    general: make(15 * MIN, 300),
    auth: make(15 * MIN, 10),
    google: make(15 * MIN, 20),
    startAttempt: make(10 * MIN, 30),
    answers: make(MIN, 120, attemptKey),
    flag: make(MIN, 30, attemptKey),
    ai: make(10 * MIN, 10, teacherKey),
  };
};

module.exports = { createLimiters };

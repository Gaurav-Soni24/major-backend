const mongoose = require('mongoose');
const User = require('../models/User');
const Submission = require('../models/Submission');
const { AppError } = require('../utils/AppError');
const { verifyTeacherToken, verifyStudentToken, hashAttemptToken, hashesEqual } = require('../services/tokenService');
const { ConfigError } = require('../config/env');

const idOk = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) && mongoose.isValidObjectId(id);

const bearerToken = (req) => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
};

const studentTokenFrom = (req) => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Student\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
};

// Teacher auth: `Authorization: Bearer <jwt>`. Role is read from the database so a deleted or
// demoted account loses access immediately.
const protect = async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Not authorized, no token');
    let decoded;
    try {
      decoded = verifyTeacherToken(token);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new AppError(401, 'UNAUTHENTICATED', 'Not authorized, token failed');
    }
    if (!idOk(decoded.userId)) throw new AppError(401, 'UNAUTHENTICATED', 'Not authorized, token failed');
    const user = await User.findById(decoded.userId).select('role');
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Not authorized, account not found');
    req.user = { userId: String(user._id), role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};

const parseStudent = (req) => {
  const token = studentTokenFrom(req);
  if (!token) throw new AppError(401, 'STUDENT_TOKEN_INVALID', 'Student sign-in required');
  try {
    return verifyStudentToken(token);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new AppError(401, 'STUDENT_TOKEN_INVALID', 'Student sign-in expired or invalid');
  }
};

// Student identity: `Authorization: Student <jwt>` issued by /submissions/verify-google.
const requireStudent = (req, res, next) => {
  try {
    req.student = parseStudent(req);
    next();
  } catch (err) {
    next(err);
  }
};

// Resolves a submission from the attempt token (X-Attempt-Token). The submission id comes from
// the URL param or the body. Compares SHA-256 hashes in constant time.
const loadAttempt = async (req) => {
  const token = req.get('x-attempt-token');
  if (!token || typeof token !== 'string' || token.length > 256) {
    throw new AppError(401, 'ATTEMPT_TOKEN_INVALID', 'Attempt token required');
  }
  const id = (req.params && req.params.submissionId) || (req.body && req.body.submissionId);
  if (!idOk(id)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid submission id', [{ field: 'submissionId', message: 'submissionId is not a valid id' }]);
  }
  const submission = await Submission.findById(id).select('+attemptTokenHash -antiCheat.flaggedImages');
  // Same answer for "no such attempt" and "wrong token": do not reveal which ids exist.
  if (!submission || !hashesEqual(hashAttemptToken(token), submission.attemptTokenHash)) {
    throw new AppError(403, 'ATTEMPT_TOKEN_INVALID', 'Attempt token is not valid for this attempt');
  }
  return submission;
};

const requireAttempt = async (req, res, next) => {
  try {
    req.submission = await loadAttempt(req);
    next();
  } catch (err) {
    next(err);
  }
};

// Result page access: the attempt token OR the student token of the same email.
const requireAttemptOrOwnerStudent = async (req, res, next) => {
  try {
    if (req.get('x-attempt-token')) {
      req.submission = await loadAttempt(req);
      return next();
    }
    if (!studentTokenFrom(req)) throw new AppError(401, 'ATTEMPT_TOKEN_INVALID', 'Attempt token or student sign-in required');
    const student = parseStudent(req);
    const id = req.params.submissionId;
    if (!idOk(id)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid submission id');
    const submission = await Submission.findById(id).select('-antiCheat.flaggedImages');
    if (!submission || submission.userDetails.email.toLowerCase() !== student.email) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this result');
    }
    req.student = student;
    req.submission = submission;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { protect, requireStudent, requireAttempt, requireAttemptOrOwnerStudent };

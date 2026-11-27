const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtSecret, studentSecret } = require('../config/env');

const ALG = ['HS256'];

const signTeacherToken = (userId, role) =>
  jwt.sign({ userId: String(userId), role }, jwtSecret(), { expiresIn: '8h', algorithm: 'HS256' });

const verifyTeacherToken = (token) => {
  const decoded = jwt.verify(token, jwtSecret(), { algorithms: ALG });
  // A student token (purpose set) must never act as a teacher token.
  if (!decoded || !decoded.userId || decoded.purpose) throw new Error('not a teacher token');
  return decoded;
};

const signStudentToken = ({ email, name, googleId }) =>
  jwt.sign({ email, name, googleId: googleId || null, purpose: 'student' }, studentSecret(), {
    expiresIn: '2h',
    algorithm: 'HS256',
  });

const verifyStudentToken = (token) => {
  const decoded = jwt.verify(token, studentSecret(), { algorithms: ALG });
  if (!decoded || decoded.purpose !== 'student' || !decoded.email) throw new Error('not a student token');
  return { email: String(decoded.email).toLowerCase(), name: decoded.name || '', googleId: decoded.googleId || null };
};

// Attempt token: 32 random bytes (hex). Only its SHA-256 is stored.
const newAttemptToken = () => crypto.randomBytes(32).toString('hex');
const hashAttemptToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const hashesEqual = (aHex, bHex) => {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

module.exports = {
  signTeacherToken,
  verifyTeacherToken,
  signStudentToken,
  verifyStudentToken,
  newAttemptToken,
  hashAttemptToken,
  hashesEqual,
};

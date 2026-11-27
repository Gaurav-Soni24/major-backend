// Central place for environment-derived settings. Nothing here has a secret default.
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.isConfig = true;
  }
}

const jwtSecret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new ConfigError('JWT_SECRET is not configured');
  return s;
};

// Student and attempt tokens may use their own secret; falls back to JWT_SECRET.
const studentSecret = () => {
  const s = process.env.STUDENT_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!s) throw new ConfigError('STUDENT_TOKEN_SECRET or JWT_SECRET is not configured');
  return s;
};

const graceMs = () => {
  const n = Number(process.env.ATTEMPT_GRACE_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 15) * 1000;
};

const corsOrigins = () =>
  (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

const trustProxy = () => {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
};

// Called by server.js before listening. Throws a readable error (no crash loop in tests,
// because tests never call it).
const assertConfig = () => {
  const missing = [];
  if (!process.env.MONGO_URI) missing.push('MONGO_URI');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 16) {
    console.warn('WARNING: JWT_SECRET is shorter than 16 characters. Use a long random string.');
  }
};

module.exports = { ConfigError, jwtSecret, studentSecret, graceMs, corsOrigins, trustProxy, assertConfig };

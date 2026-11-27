const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const isHashed = (v) => typeof v === 'string' && BCRYPT_RE.test(v);

// '' (no password) stays ''.
const hashQuizPassword = async (plain) => (plain ? bcrypt.hash(plain, 10) : '');

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

/**
 * Checks a student-supplied password against the stored one.
 * Returns { ok, legacy }: `legacy` is true when the stored value was plaintext (caller re-hashes it).
 */
const checkQuizPassword = async (stored, provided) => {
  if (!stored) return { ok: true, legacy: false };
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 64) return { ok: false, legacy: false };
  if (isHashed(stored)) return { ok: await bcrypt.compare(provided, stored), legacy: false };
  return { ok: safeEqual(stored, provided), legacy: true };
};

module.exports = { isHashed, hashQuizPassword, checkQuizPassword };

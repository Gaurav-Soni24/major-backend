const { AppError } = require('../utils/AppError');

const MAX_DEPTH = 12;

// Query-string keys additionally must not look like bracket syntax (`a[$ne]`).
const STRICT_KEY = /[$[\]]/;

// Returns the first offending path, or null.
const findBadKey = (value, path = '', depth = 0, strict = false) => {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return `${path || 'body'} (nested too deeply)`;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  for (const [k, v] of entries) {
    const here = path ? `${path}.${k}` : k;
    if (!Array.isArray(value) && (k.startsWith('$') || k.includes('.') || (strict && STRICT_KEY.test(k)))) return here;
    const bad = findBadKey(v, here, depth + 1, strict);
    if (bad) return bad;
  }
  return null;
};

// NoSQL-injection guard: JSON bodies must be plain objects and no key may start with `$` or contain `.`.
// Also applied to the query string and route params.
const noSqlGuard = (req, res, next) => {
  try {
    if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object', [{ field: 'body', message: 'Expected a JSON object' }]);
    }
    if (req.body === undefined) req.body = {};
    for (const [label, part] of [['body', req.body], ['query', req.query], ['params', req.params]]) {
      const bad = findBadKey(part, '', 0, label === 'query');
      if (bad) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Request contains disallowed characters in field names', [
          { field: `${label}.${bad}`, message: 'Keys must not start with "$" or contain "."' },
        ]);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { noSqlGuard, findBadKey };

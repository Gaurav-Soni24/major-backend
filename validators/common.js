const mongoose = require('mongoose');
const { AppError } = require('../utils/AppError');

// Small collector so validators can report every problem at once.
class Issues {
  constructor() {
    this.list = [];
  }
  add(field, message) {
    this.list.push({ field, message });
  }
  get ok() {
    return this.list.length === 0;
  }
  throwIfAny(message = 'Validation failed') {
    if (this.list.length) throw new AppError(400, 'VALIDATION_ERROR', message, this.list);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && mongoose.isValidObjectId(v);

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Reads a string field with length bounds; returns the trimmed value or undefined (after recording an issue).
const str = (issues, obj, field, { min = 0, max, required = false, label = field, trim = true } = {}) => {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (required) issues.add(label, `${label} is required`);
    return undefined;
  }
  if (!isString(v)) {
    issues.add(label, `${label} must be a string`);
    return undefined;
  }
  const t = trim ? v.trim() : v;
  if (t.length < min) {
    issues.add(label, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`);
    return undefined;
  }
  if (max !== undefined && t.length > max) {
    issues.add(label, `${label} must be at most ${max} characters`);
    return undefined;
  }
  return t;
};

const bool = (issues, obj, field, def, label = field) => {
  const v = obj[field];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') {
    issues.add(label, `${label} must be true or false`);
    return def;
  }
  return v;
};

const int = (issues, v, label, { min, max }) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    issues.add(label, `${label} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return v;
};

const queryError = (name, message) =>
  new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', [{ field: name, message }]);

// Reads one query-string value that must be a plain string.
const queryString = (query, name, { max = 100, oneOf } = {}) => {
  const v = query ? query[name] : undefined;
  if (v === undefined || v === '') return undefined;
  if (!isString(v)) throw queryError(name, `${name} must be a single value`);
  const t = v.trim().slice(0, max);
  if (oneOf && !oneOf.includes(t)) throw queryError(name, `${name} must be one of: ${oneOf.join(', ')}`);
  return t;
};

const parsePagination = (query) => {
  const toInt = (v, d) => (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : d);
  const page = Math.max(1, toInt(query && query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(query && query.limit, 20)));
  return { page, limit, skip: (page - 1) * limit };
};

const paginationMeta = ({ page, limit }, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

const assertObjectId = (id, label = 'id') => {
  if (!isObjectId(id)) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${label}`, [{ field: label, message: `${label} is not a valid id` }]);
  }
  return id;
};

module.exports = {
  Issues,
  isPlainObject,
  isString,
  isObjectId,
  emailRe,
  str,
  bool,
  int,
  queryString,
  parsePagination,
  paginationMeta,
  assertObjectId,
};

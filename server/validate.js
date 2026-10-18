'use strict';
const { badRequest } = require('./errors');

function str(value, name, { min = 1, max = 100, optional = false, pattern, patternMsg } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be text`);
  const v = value.trim();
  if (v.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (v.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  if (pattern && !pattern.test(v)) throw badRequest(patternMsg || `${name} is not valid`);
  return v;
}

function int(value, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${name} must be a whole number`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

function num(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
    throw badRequest(`${name} must be a number`);
  }
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

function oneOf(value, name, allowed, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (!allowed.includes(value)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

const isoDate = (value, name) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  return value;
};

module.exports = { str, int, num, oneOf, isoDate };

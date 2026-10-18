'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('../config');
const { unauthorized, forbidden } = require('../errors');

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${cfg.cookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(cfg.cookieName.length + 1)) : null;
}

function signToken(employee) {
  return jwt.sign(
    { sub: employee.EmployeeID, role: employee.Role, name: `${employee.FirstName} ${employee.LastName}` },
    cfg.jwtSecret,
    { expiresIn: cfg.jwtExpiresIn }
  );
}

function authenticate(req, _res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized());
  try {
    const p = jwt.verify(token, cfg.jwtSecret);
    req.user = { id: Number(p.sub), role: p.role, name: p.name };
    return next();
  } catch {
    return next(unauthorized('Session expired — please sign in again'));
  }
}

/** Role-based access control, mirrors the "cashiers cannot modify machine records" rule. */
const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden(`Requires role: ${roles.join(' or ')}`));

module.exports = { signToken, authenticate, requireRole };

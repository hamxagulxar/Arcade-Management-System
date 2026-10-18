'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { authenticate, requireRole, signToken } = require('../middleware/auth');
const { badRequest, unauthorized, notFound } = require('../errors');
const V = require('../validate');
const { REPORTS, catalog, toCsv } = require('../services/reports');

const MGR = 'Manager';
const FRONT = ['Manager', 'Cashier']; // front-desk operations
const TECH = ['Manager', 'Technician'];

const id = (req, name = 'id') => V.int(req.params[name], name, { min: 1 });

module.exports = function buildRouter(service, db) {
  const r = express.Router();

  // ---------------------------------------------------------------- auth
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: cfg.loginRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in a few minutes.' },
  });

  r.post('/auth/login', loginLimiter, (req, res) => {
    const username = V.str(req.body.username, 'Username', { max: 30 });
    const password = V.str(req.body.password, 'Password', { max: 72 });
    const emp = db.prepare('SELECT * FROM Employee WHERE Username = ?').get(username);
    // Always run a hash comparison so response time does not reveal whether the user exists.
    const ok = bcrypt.compareSync(password, emp?.PasswordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!emp || !ok) throw unauthorized('Invalid username or password');
    const token = signToken(emp);
    res.cookie(cfg.cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.isProd,
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ user: { id: emp.EmployeeID, name: `${emp.FirstName} ${emp.LastName}`, role: emp.Role }, token });
  });

  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(cfg.cookieName);
    res.json({ ok: true });
  });

  // Everything below requires a valid session.
  r.use(authenticate);

  r.get('/auth/me', (req, res) => res.json({ user: req.user }));

  r.post('/auth/change-password', (req, res) => {
    const current = V.str(req.body.currentPassword, 'Current password', { max: 72 });
    const next = V.str(req.body.newPassword, 'New password', { min: 8, max: 72 });
    const emp = db.prepare('SELECT PasswordHash FROM Employee WHERE EmployeeID = ?').get(req.user.id);
    if (!emp || !bcrypt.compareSync(current, emp.PasswordHash)) throw badRequest('Current password is incorrect');
    db.prepare('UPDATE Employee SET PasswordHash = ? WHERE EmployeeID = ?').run(bcrypt.hashSync(next, 10), req.user.id);
    res.json({ ok: true });
  });

  // ----------------------------------------------------------- dashboard
  r.get('/dashboard', (_req, res) => res.json(service.dashboard()));

  // ------------------------------------------------------- zones & machines
  r.get('/zones', (_req, res) => res.json(service.listZones()));
  r.post('/zones', requireRole(MGR), (req, res) => res.status(201).json(service.addZone(req.body)));
  r.delete('/zones/:id', requireRole(MGR), (req, res) => {
    service.deleteZone(id(req));
    res.status(204).end();
  });
  r.get('/zones/:id/tree', (req, res) => res.json(service.zoneTree(id(req))));

  r.get('/machines', (_req, res) => res.json(service.listMachines()));
  r.get('/games', (_req, res) => res.json(service.gameCatalog()));
  r.post('/machines', requireRole(MGR), (req, res) => res.status(201).json(service.addMachine(req.body)));
  r.patch('/machines/:id', requireRole(...TECH), (req, res) => res.json(service.updateMachine(id(req), req.body)));

  // ----------------------------------------------------------- customers
  r.get('/memberships', (_req, res) => res.json(service.listMemberships()));
  r.get('/customers', requireRole(...FRONT), (req, res) => res.json(service.listCustomers(req.query.search)));
  r.post('/customers', requireRole(...FRONT), (req, res) => res.status(201).json(service.registerCustomer(req.body)));
  r.get('/customers/:id', requireRole(...FRONT), (req, res) => res.json(service.getCustomer(id(req))));
  r.post('/customers/:id/topup', requireRole(...FRONT), (req, res) =>
    res.status(201).json(service.topUp(id(req), req.user.id, req.body))
  );
  r.get('/transactions', requireRole(...FRONT), (_req, res) => res.json(service.listTransactions()));

  // ---------------------------------------------------- token request queue
  r.get('/tokens/queue', (_req, res) => res.json(service.queueView()));
  r.post('/tokens', requireRole(...FRONT), (req, res) => res.status(201).json(service.enqueueRequest(req.body)));
  r.delete('/tokens/:id', requireRole(...FRONT), (req, res) => {
    service.cancelRequest(id(req));
    res.status(204).end();
  });
  r.post('/tokens/process-next', requireRole(...FRONT), (_req, res) => res.json(service.processQueue({ limit: 1 })));
  r.post('/tokens/process-all', requireRole(...FRONT), (_req, res) => res.json(service.processQueue()));

  // ------------------------------------------------------------ sessions
  r.get('/sessions', (req, res) => {
    const status = V.oneOf(req.query.status, 'status', ['Active', 'Completed', 'Cancelled'], { optional: true });
    res.json(service.listSessions({ status: status || undefined, limit: V.int(req.query.limit ?? 50, 'limit', { min: 1, max: 200 }) }));
  });
  r.get('/sessions/stack', (_req, res) => res.json(service.sessionStack()));
  r.post('/sessions', requireRole(...FRONT), (req, res) => res.status(201).json(service.startSession(req.body)));
  r.post('/sessions/rollback', requireRole(MGR), (_req, res) => res.json(service.rollbackLastSession()));
  r.post('/sessions/:id/end', requireRole(...FRONT), (req, res) => res.json(service.endSession(id(req), req.body)));

  // --------------------------------------------------------- maintenance
  r.get('/maintenance', (req, res) => res.json(service.listMaintenance({ status: req.query.status })));
  r.post('/maintenance', requireRole(...TECH), (req, res) => {
    // Technicians open tickets for themselves; managers choose the technician.
    const body = req.user.role === 'Technician' ? { ...req.body, employeeId: req.user.id } : req.body;
    res.status(201).json(service.openMaintenance(body));
  });
  r.patch('/maintenance/:id', requireRole(...TECH), (req, res) => res.json(service.updateMaintenance(id(req), req.body)));

  // ----------------------------------------------------------- employees
  r.get('/technicians', (_req, res) => res.json(service.listTechnicians()));
  r.get('/employees', requireRole(MGR), (_req, res) => res.json(service.listEmployees()));
  r.post('/employees', requireRole(MGR), (req, res) => res.status(201).json(service.createEmployee(req.body)));

  // ------------------------------------------------------------- reports
  r.get('/reports', requireRole(MGR), (_req, res) => res.json(catalog()));
  r.get('/reports/:key', requireRole(MGR), (req, res) => {
    const report = REPORTS[req.params.key];
    if (!report) throw notFound('Unknown report');
    const rows = report.run(db, req.query);
    if (req.query.format === 'csv') {
      res.type('text/csv').attachment(`${req.params.key}.csv`).send(toCsv(rows));
      return;
    }
    res.json({ key: req.params.key, title: report.title, description: report.description, rows });
  });

  r.use((_req, _res, next) => next(notFound('No such API endpoint')));
  return r;
};

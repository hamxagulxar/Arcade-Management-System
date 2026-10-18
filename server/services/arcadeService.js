'use strict';
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { ArcadeEngine } = require('../dsa/ArcadeEngine');
const { computeCost, rewardPointsFor } = require('./pricing');
const { badRequest, notFound, conflict } = require('../errors');
const V = require('../validate');

const MACHINE_STATUSES = ['Available', 'In Use', 'Reserved', 'Out of Order', 'Under Maintenance', 'Decommissioned'];
// Statuses staff may set by hand. "In Use" is controlled by sessions and
// "Under Maintenance" by maintenance tickets, so they are not hand-settable.
const MANUAL_STATUSES = ['Available', 'Reserved', 'Out of Order', 'Decommissioned'];

const nowIso = () => new Date().toISOString();
const clean = (m) => ({ ...m }); // detach from the live tree node before sending to clients

/**
 * ArcadeService — all business rules. The database is the source of truth;
 * after every committed write the in-memory ArcadeEngine is updated to match.
 */
class ArcadeService {
  constructor(db) {
    this.db = db;
    this.engine = new ArcadeEngine().hydrate(db);
  }

  // ---------------------------------------------------------------- zones
  listZones() {
    return this.engine.zones.toArray().map((zn) => ({
      ...zn.zone,
      machineCount: zn.tree.size,
      treeHeight: zn.tree.height,
      machines: zn.tree.inOrder().map(clean), // in-order traversal => sorted by MachineID
    }));
  }

  addZone(body) {
    const name = V.str(body.zoneName, 'Zone name', { max: 40 });
    if (this.engine.zones.findByName(name)) throw conflict(`Zone '${name}' already exists`);
    const info = this.db.prepare('INSERT INTO Zone (ZoneName) VALUES (?)').run(name);
    const zone = { ZoneID: Number(info.lastInsertRowid), ZoneName: name };
    this.engine.zones.append(zone);
    return { ...zone, machineCount: 0, treeHeight: 0, machines: [] };
  }

  deleteZone(id) {
    const node = this.engine.zones.findById(id);
    if (!node) throw notFound('Zone not found');
    if (node.tree.size > 0) throw conflict('Zone still has machines — move or decommission them first');
    this.db.prepare('DELETE FROM Zone WHERE ZoneID = ?').run(id);
    this.engine.zones.remove(id);
  }

  zoneTree(id) {
    const node = this.engine.zones.findById(id);
    if (!node) throw notFound('Zone not found');
    return { zone: node.zone, height: node.tree.height, size: node.tree.size, root: node.tree.toJSON() };
  }

  // ------------------------------------------------------------- machines
  listMachines() {
    const out = [];
    for (const zn of this.engine.zones) {
      for (const m of zn.tree.inOrder()) out.push({ ...clean(m), ZoneName: zn.zone.ZoneName });
    }
    return out;
  }

  gameCatalog() {
    const names = new Set();
    const genres = new Set();
    for (const m of this.engine.machines.values()) {
      if (m.Status === 'Decommissioned') continue;
      names.add(m.MachineName);
      genres.add(m.GameType);
    }
    return { games: [...names].sort(), genres: [...genres].sort() };
  }

  addMachine(body) {
    const zoneId = V.int(body.zoneId, 'Zone', { min: 1 });
    if (!this.engine.zones.findById(zoneId)) throw badRequest('Zone does not exist');
    const row = {
      name: V.str(body.machineName, 'Machine name', { max: 80 }),
      genre: V.str(body.gameType, 'Game type', { max: 40 }),
      cost: V.int(body.creditCost, 'Credit cost', { min: 1, max: 100 }),
      token: V.int(body.tokenType ?? 1, 'Token type', { min: 1, max: 3 }),
      status: V.oneOf(body.status ?? 'Available', 'Status', MANUAL_STATUSES.slice(0, 3)),
    };
    const info = this.db
      .prepare(
        `INSERT INTO Machine (ZoneID, MachineName, GameType, CreditCost, TokenType, Status, InstallDate)
         VALUES (?,?,?,?,?,?,date('now'))`
      )
      .run(zoneId, row.name, row.genre, row.cost, row.token, row.status);
    const machine = this.db.prepare('SELECT * FROM Machine WHERE MachineID = ?').get(info.lastInsertRowid);
    this.engine.addMachine(machine);
    return clean(machine);
  }

  updateMachine(id, body) {
    const live = this.engine.getMachine(id);
    if (!live) throw notFound('Machine not found');
    const patch = {};
    if (body.machineName !== undefined) patch.MachineName = V.str(body.machineName, 'Machine name', { max: 80 });
    if (body.gameType !== undefined) patch.GameType = V.str(body.gameType, 'Game type', { max: 40 });
    if (body.creditCost !== undefined) patch.CreditCost = V.int(body.creditCost, 'Credit cost', { min: 1, max: 100 });
    if (body.tokenType !== undefined) patch.TokenType = V.int(body.tokenType, 'Token type', { min: 1, max: 3 });
    if (body.status !== undefined && body.status !== live.Status) {
      V.oneOf(body.status, 'Status', MACHINE_STATUSES);
      if (live.Status === 'In Use') throw conflict('Machine is in use — end its session first');
      if (live.Status === 'Under Maintenance') throw conflict('Resolve the open maintenance ticket to release this machine');
      if (!MANUAL_STATUSES.includes(body.status)) {
        throw badRequest(
          body.status === 'In Use'
            ? 'Machines become "In Use" automatically when a session starts'
            : 'Open a maintenance ticket to mark a machine "Under Maintenance"'
        );
      }
      patch.Status = body.status;
    }
    const cols = Object.keys(patch);
    if (!cols.length) throw badRequest('Nothing to update');
    this.db
      .prepare(`UPDATE Machine SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE MachineID = @id`)
      .run({ ...patch, id });
    Object.assign(live, patch);
    return clean(live);
  }

  // ------------------------------------------------------------ customers
  listMemberships() {
    return this.db.prepare('SELECT * FROM Membership ORDER BY MembershipID').all();
  }

  listCustomers(search) {
    const like = `%${String(search || '').trim()}%`;
    return this.db
      .prepare(
        `SELECT c.*, m.MembershipType, m.DiscountRate
         FROM Customer c LEFT JOIN Membership m ON m.MembershipID = c.MembershipID
         WHERE (? = '%%') OR c.FirstName || ' ' || c.LastName LIKE ? OR c.Phone LIKE ? OR c.Email LIKE ?
         ORDER BY c.CustomerID`
      )
      .all(like, like, like, like);
  }

  #customer(id) {
    const c = this.db
      .prepare(
        `SELECT c.*, COALESCE(m.MembershipType,'Basic') AS MembershipType, COALESCE(m.DiscountRate,0) AS DiscountRate
         FROM Customer c LEFT JOIN Membership m ON m.MembershipID = c.MembershipID WHERE c.CustomerID = ?`
      )
      .get(id);
    if (!c) throw notFound('Customer not found');
    return c;
  }

  getCustomer(id) {
    const c = this.#customer(id);
    c.sessions = this.db
      .prepare(
        `SELECT s.SessionID, s.StartTime, s.EndTime, s.CreditsUsed, s.Score, s.Status, m.MachineName
         FROM Session s JOIN Machine m ON m.MachineID = s.MachineID
         WHERE s.CustomerID = ? ORDER BY s.StartTime DESC LIMIT 10`
      )
      .all(id);
    c.transactions = this.db
      .prepare(
        `SELECT TransactionID, Amount, PaymentMethod, TransactionDate, CreditsAdded
         FROM "Transaction" WHERE CustomerID = ? ORDER BY TransactionDate DESC LIMIT 10`
      )
      .all(id);
    return c;
  }

  registerCustomer(body) {
    const phone = V.str(body.phone, 'Phone', {
      optional: true,
      max: 15,
      pattern: /^[0-9+\-\s]{7,15}$/,
      patternMsg: 'Phone must be 7–15 digits (spaces, + and - allowed)',
    });
    const email = V.str(body.email, 'Email', {
      optional: true,
      max: 100,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      patternMsg: 'Email is not valid',
    });
    const membershipId = V.int(body.membershipId ?? 1, 'Membership', { min: 1 });
    if (!this.db.prepare('SELECT 1 FROM Membership WHERE MembershipID = ?').get(membershipId)) {
      throw badRequest('Membership does not exist');
    }
    try {
      const info = this.db
        .prepare(
          'INSERT INTO Customer (MembershipID, FirstName, LastName, Phone, Email) VALUES (?,?,?,?,?)'
        )
        .run(
          membershipId,
          V.str(body.firstName, 'First name', { max: 50 }),
          V.str(body.lastName, 'Last name', { max: 50 }),
          phone,
          email
        );
      return this.#customer(Number(info.lastInsertRowid));
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('A customer with that phone or email already exists');
      throw e;
    }
  }

  topUp(customerId, employeeId, body) {
    const amount = V.num(body.amount, 'Amount', { min: 1, max: 100000 });
    const method = V.oneOf(body.paymentMethod ?? 'Cash', 'Payment method', ['Cash', 'Card', 'Online']);
    const credits = Math.floor(amount / cfg.pkrPerCredit);
    if (credits < 1) throw badRequest(`Minimum top-up is Rs ${cfg.pkrPerCredit} (1 credit)`);
    this.#customer(customerId);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO "Transaction" (CustomerID, EmployeeID, Amount, PaymentMethod, TransactionDate, CreditsAdded) VALUES (?,?,?,?,?,?)'
        )
        .run(customerId, employeeId, amount, method, nowIso(), credits);
      this.db.prepare('UPDATE Customer SET CreditBalance = CreditBalance + ? WHERE CustomerID = ?').run(credits, customerId);
    })();
    return { ...this.#customer(customerId), creditsAdded: credits };
  }

  listTransactions(limit = 50) {
    return this.db
      .prepare(
        `SELECT t.*, c.FirstName || ' ' || c.LastName AS CustomerName, e.FirstName || ' ' || e.LastName AS EmployeeName
         FROM "Transaction" t JOIN Customer c ON c.CustomerID = t.CustomerID JOIN Employee e ON e.EmployeeID = t.EmployeeID
         ORDER BY t.TransactionDate DESC, t.TransactionID DESC LIMIT ?`
      )
      .all(limit);
  }

  // ---------------------------------------------------- token request queue
  queueView() {
    const decorate = (list) => list.map((r, i) => ({ ...r, Position: i + 1 }));
    return {
      high: decorate(this.engine.queue.high.toArray()),
      normal: decorate(this.engine.queue.normal.toArray()),
      size: this.engine.queue.size,
    };
  }

  enqueueRequest(body) {
    const customerId = V.int(body.customerId, 'Customer', { min: 1 });
    const game = V.str(body.game, 'Game', { max: 80 });
    const minutes = V.int(body.sessionMinutes, 'Session length (minutes)', { min: 5, max: 240 });
    const wanted = V.oneOf(body.priority ?? 'Auto', 'Priority', ['Auto', 'High', 'Normal']);
    const customer = this.#customer(customerId);

    const candidates = this.engine.matchingMachines(game);
    if (!candidates.length) throw badRequest(`No machine or genre called '${game}' exists`);
    const cheapest = Math.min(
      ...candidates.map((m) => computeCost({ creditCost: m.CreditCost, minutes, discountRate: customer.DiscountRate }))
    );
    if (customer.CreditBalance < cheapest) {
      throw badRequest(`Insufficient credits: needs ${cheapest}, ${customer.FirstName} has ${customer.CreditBalance}`);
    }
    const priority =
      wanted === 'Auto' ? (['Gold', 'Platinum'].includes(customer.MembershipType) ? 'High' : 'Normal') : wanted;

    const info = this.db
      .prepare('INSERT INTO TokenRequest (CustomerID, Game, SessionMinutes, Priority, CreatedAt) VALUES (?,?,?,?,?)')
      .run(customerId, game, minutes, priority, nowIso());
    const request = this.db
      .prepare(
        `SELECT t.*, c.FirstName || ' ' || c.LastName AS CustomerName FROM TokenRequest t
         JOIN Customer c ON c.CustomerID = t.CustomerID WHERE t.RequestID = ?`
      )
      .get(info.lastInsertRowid);
    this.engine.queue.enqueue(request);
    return request;
  }

  cancelRequest(requestId) {
    const removed = this.engine.queue.remove(requestId);
    if (!removed) throw notFound('That request is not waiting in the queue');
    this.db
      .prepare("UPDATE TokenRequest SET Status = 'Cancelled', ResolvedAt = ? WHERE RequestID = ?")
      .run(nowIso(), requestId);
  }

  /**
   * Serve waiting requests in priority order (high first, FIFO inside each level).
   * A request with no free machine stays queued, so it never blocks later requests
   * for other games. `limit` = max number of sessions to start.
   */
  processQueue({ limit = Infinity } = {}) {
    const results = [];
    let started = 0;
    for (const req of this.engine.queue.toArray()) {
      if (started >= limit) break;
      const outcome = this.#serve(req);
      results.push(outcome);
      if (outcome.outcome === 'assigned') started += 1;
    }
    return { results, queue: this.queueView() };
  }

  #serve(req) {
    const base = { requestId: req.RequestID, customer: req.CustomerName, game: req.Game, priority: req.Priority };
    const machine = this.engine.findAvailableMachine(req.Game);
    if (!machine) return { ...base, outcome: 'waiting', reason: 'No available machine right now' };

    const customer = this.#customer(req.CustomerID);
    const cost = computeCost({
      creditCost: machine.CreditCost,
      minutes: req.SessionMinutes,
      discountRate: customer.DiscountRate,
    });
    if (customer.CreditBalance < cost) {
      const reason = `Insufficient credits (needs ${cost}, has ${customer.CreditBalance})`;
      this.db
        .prepare("UPDATE TokenRequest SET Status = 'Rejected', Note = ?, ResolvedAt = ? WHERE RequestID = ?")
        .run(reason, nowIso(), req.RequestID);
      this.engine.queue.remove(req.RequestID);
      return { ...base, outcome: 'rejected', reason };
    }
    const session = this.#startSession(customer, machine, req.SessionMinutes, req.RequestID);
    this.engine.queue.remove(req.RequestID);
    return { ...base, outcome: 'assigned', machine: machine.MachineName, machineId: machine.MachineID, session };
  }

  // ------------------------------------------------------------- sessions
  #startSession(customer, machine, minutes, requestId = null) {
    const cost = computeCost({ creditCost: machine.CreditCost, minutes, discountRate: customer.DiscountRate });
    const start = nowIso();
    const sessionId = this.db.transaction(() => {
      const fresh = this.db.prepare('SELECT Status FROM Machine WHERE MachineID = ?').get(machine.MachineID);
      if (!fresh) throw notFound('Machine not found');
      if (fresh.Status !== 'Available') {
        throw conflict(`Machine ${machine.MachineID} is ${fresh.Status} — a machine runs one session at a time`);
      }
      const balance = this.db.prepare('SELECT CreditBalance FROM Customer WHERE CustomerID = ?').get(customer.CustomerID);
      if (balance.CreditBalance < cost) {
        throw badRequest(`Insufficient credits: needs ${cost}, has ${balance.CreditBalance}`);
      }
      this.db.prepare("UPDATE Machine SET Status = 'In Use' WHERE MachineID = ?").run(machine.MachineID);
      this.db.prepare('UPDATE Customer SET CreditBalance = CreditBalance - ? WHERE CustomerID = ?').run(cost, customer.CustomerID);
      const info = this.db
        .prepare(
          `INSERT INTO Session (CustomerID, MachineID, RequestID, StartTime, PlannedMinutes, CreditsUsed, Status)
           VALUES (?,?,?,?,?,?,'Active')`
        )
        .run(customer.CustomerID, machine.MachineID, requestId, start, minutes, cost);
      const sid = Number(info.lastInsertRowid);
      if (requestId) {
        this.db
          .prepare("UPDATE TokenRequest SET Status = 'Assigned', SessionID = ?, ResolvedAt = ? WHERE RequestID = ?")
          .run(sid, start, requestId);
      }
      return sid;
    })();

    // Database committed — mirror the change in the data structures.
    machine.Status = 'In Use';
    const record = {
      SessionID: sessionId,
      CustomerID: customer.CustomerID,
      MachineID: machine.MachineID,
      CustomerName: `${customer.FirstName} ${customer.LastName}`,
      MachineName: machine.MachineName,
      PlannedMinutes: minutes,
      CreditsUsed: cost,
      Status: 'Active',
      StartTime: start,
      Score: 0,
    };
    this.engine.sessions.push(record);
    return { ...record };
  }

  /** Walk-up play: start a session directly on a chosen machine (no queue). */
  startSession(body) {
    const customer = this.#customer(V.int(body.customerId, 'Customer', { min: 1 }));
    const machine = this.engine.getMachine(V.int(body.machineId, 'Machine', { min: 1 }));
    if (!machine) throw notFound('Machine not found');
    const minutes = V.int(body.minutes, 'Session length (minutes)', { min: 5, max: 240 });
    return this.#startSession(customer, machine, minutes);
  }

  endSession(sessionId, body = {}) {
    const score = V.int(body.score ?? 0, 'Score', { min: 0, max: 100000000 });
    const s = this.db.prepare('SELECT * FROM Session WHERE SessionID = ?').get(sessionId);
    if (!s) throw notFound('Session not found');
    if (s.Status !== 'Active') throw conflict(`Session is already ${s.Status.toLowerCase()}`);
    const end = new Date(Math.max(Date.now(), Date.parse(s.StartTime))).toISOString();
    const points = rewardPointsFor(s.CreditsUsed);
    this.db.transaction(() => {
      this.db.prepare("UPDATE Session SET EndTime = ?, Score = ?, Status = 'Completed' WHERE SessionID = ?").run(end, score, sessionId);
      this.db.prepare("UPDATE Machine SET Status = 'Available' WHERE MachineID = ? AND Status = 'In Use'").run(s.MachineID);
      this.db.prepare('UPDATE Customer SET RewardPoints = RewardPoints + ? WHERE CustomerID = ?').run(points, s.CustomerID);
    })();
    const machine = this.engine.getMachine(s.MachineID);
    if (machine && machine.Status === 'In Use') machine.Status = 'Available';
    const rec = this.engine.sessions.toArray().find((r) => r.SessionID === sessionId);
    if (rec) Object.assign(rec, { Status: 'Completed', Score: score });
    return { sessionId, score, rewardPoints: points };
  }

  /** Stack pop: cancel the most recent session, refund its credits and free its machine. */
  rollbackLastSession() {
    const top = this.engine.sessions.peek();
    if (!top) throw notFound('No session to roll back');
    const s = this.db.prepare('SELECT * FROM Session WHERE SessionID = ?').get(top.SessionID);
    const end = s.EndTime || new Date(Math.max(Date.now(), Date.parse(s.StartTime))).toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE Session SET Status = 'Cancelled', EndTime = ? WHERE SessionID = ?").run(end, s.SessionID);
      this.db
        .prepare('UPDATE Customer SET CreditBalance = CreditBalance + ? WHERE CustomerID = ?')
        .run(s.CreditsUsed, s.CustomerID);
      if (s.Status === 'Completed') {
        this.db
          .prepare('UPDATE Customer SET RewardPoints = MAX(0, RewardPoints - ?) WHERE CustomerID = ?')
          .run(rewardPointsFor(s.CreditsUsed), s.CustomerID);
      }
      this.db.prepare("UPDATE Machine SET Status = 'Available' WHERE MachineID = ? AND Status = 'In Use'").run(s.MachineID);
    })();
    const machine = this.engine.getMachine(s.MachineID);
    if (machine && machine.Status === 'In Use') machine.Status = 'Available';
    this.engine.sessions.pop();
    return { rolledBack: { ...top, Status: 'Cancelled' }, refunded: s.CreditsUsed };
  }

  sessionStack() {
    const items = this.engine.sessions.toArray();
    return { size: items.length, items: items.slice(0, 25).map((r, i) => ({ ...r, IsTop: i === 0 })) };
  }

  listSessions({ status, limit = 50 } = {}) {
    const where = status ? 'WHERE s.Status = ?' : '';
    const args = status ? [status, limit] : [limit];
    return this.db
      .prepare(
        `SELECT s.*, c.FirstName || ' ' || c.LastName AS CustomerName, m.MachineName, z.ZoneName
         FROM Session s JOIN Customer c ON c.CustomerID = s.CustomerID
         JOIN Machine m ON m.MachineID = s.MachineID JOIN Zone z ON z.ZoneID = m.ZoneID
         ${where} ORDER BY s.StartTime DESC, s.SessionID DESC LIMIT ?`
      )
      .all(...args);
  }

  // ---------------------------------------------------------- maintenance
  listMaintenance({ status } = {}) {
    const where = status === 'open' ? "WHERE mt.ResolutionStatus <> 'Resolved'" : '';
    return this.db
      .prepare(
        `SELECT mt.*, m.MachineName, m.Status AS MachineStatus, e.FirstName || ' ' || e.LastName AS Technician
         FROM Maintenance mt JOIN Machine m ON m.MachineID = mt.MachineID JOIN Employee e ON e.EmployeeID = mt.EmployeeID
         ${where} ORDER BY (mt.ResolutionStatus = 'Resolved'), mt.StartDate DESC, mt.MaintenanceID DESC`
      )
      .all();
  }

  openMaintenance(body) {
    const machineId = V.int(body.machineId, 'Machine', { min: 1 });
    const employeeId = V.int(body.employeeId, 'Technician', { min: 1 });
    const issue = V.str(body.issueDescription, 'Issue description', { max: 500 });
    const machine = this.engine.getMachine(machineId);
    if (!machine) throw notFound('Machine not found');
    if (machine.Status === 'In Use') throw conflict('Machine is in use — end its session before opening a ticket');
    if (machine.Status === 'Decommissioned') throw conflict('Machine is decommissioned');
    const tech = this.db.prepare('SELECT Role FROM Employee WHERE EmployeeID = ?').get(employeeId);
    if (!tech) throw badRequest('Technician does not exist');
    if (tech.Role !== 'Technician') throw badRequest('Maintenance must be assigned to an employee with the Technician role');

    const id = this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO Maintenance (MachineID, EmployeeID, IssueDescription, StartDate) VALUES (?,?,?,date(\'now\'))')
        .run(machineId, employeeId, issue);
      this.db.prepare("UPDATE Machine SET Status = 'Under Maintenance' WHERE MachineID = ?").run(machineId);
      return Number(info.lastInsertRowid);
    })();
    machine.Status = 'Under Maintenance';
    return this.db.prepare('SELECT * FROM Maintenance WHERE MaintenanceID = ?').get(id);
  }

  updateMaintenance(id, body) {
    const status = V.oneOf(body.resolutionStatus, 'Status', ['Open', 'In Progress', 'Resolved']);
    const t = this.db.prepare('SELECT * FROM Maintenance WHERE MaintenanceID = ?').get(id);
    if (!t) throw notFound('Maintenance ticket not found');
    if (t.ResolutionStatus === 'Resolved') throw conflict('Ticket is already resolved');
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE Maintenance SET ResolutionStatus = ?, EndDate = CASE WHEN ? = 'Resolved' THEN date('now') END WHERE MaintenanceID = ?")
        .run(status, status, id);
      if (status === 'Resolved') {
        const stillOpen = this.db
          .prepare("SELECT COUNT(*) n FROM Maintenance WHERE MachineID = ? AND ResolutionStatus <> 'Resolved'")
          .get(t.MachineID).n;
        if (stillOpen === 0) {
          this.db
            .prepare("UPDATE Machine SET Status = 'Available' WHERE MachineID = ? AND Status = 'Under Maintenance'")
            .run(t.MachineID);
        }
      }
    })();
    const machine = this.engine.getMachine(t.MachineID);
    const fresh = this.db.prepare('SELECT Status FROM Machine WHERE MachineID = ?').get(t.MachineID);
    if (machine && fresh) machine.Status = fresh.Status;
    return this.db.prepare('SELECT * FROM Maintenance WHERE MaintenanceID = ?').get(id);
  }

  // ------------------------------------------------------------ employees
  listEmployees() {
    return this.db
      .prepare('SELECT EmployeeID, FirstName, LastName, Role, Shift, Salary, HireDate, Phone, Username FROM Employee ORDER BY EmployeeID')
      .all();
  }

  listTechnicians() {
    return this.db
      .prepare("SELECT EmployeeID, FirstName || ' ' || LastName AS Name FROM Employee WHERE Role = 'Technician' ORDER BY FirstName")
      .all();
  }

  createEmployee(body) {
    const username = V.str(body.username, 'Username', { min: 3, max: 30, pattern: /^[a-zA-Z0-9._-]+$/, patternMsg: 'Username may contain letters, numbers, . _ -' });
    const password = V.str(body.password, 'Password', { min: 8, max: 72 });
    try {
      const info = this.db
        .prepare(
          `INSERT INTO Employee (FirstName, LastName, Role, Shift, Salary, Phone, Username, PasswordHash)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          V.str(body.firstName, 'First name', { max: 50 }),
          V.str(body.lastName, 'Last name', { max: 50 }),
          V.oneOf(body.role, 'Role', ['Manager', 'Cashier', 'Technician', 'Security']),
          V.oneOf(body.shift, 'Shift', ['Morning', 'Evening', 'Night']),
          V.num(body.salary, 'Salary', { min: 0, max: 100000000 }),
          V.str(body.phone, 'Phone', { optional: true, max: 15 }),
          username,
          bcrypt.hashSync(password, 10)
        );
      return this.listEmployees().find((e) => e.EmployeeID === Number(info.lastInsertRowid));
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('That username is already taken');
      throw e;
    }
  }

  // ------------------------------------------------------------ dashboard
  dashboard() {
    const counts = this.engine.statusCounts();
    const statuses = Object.fromEntries(MACHINE_STATUSES.map((s) => [s, counts[s] || 0]));
    const today = nowIso().slice(0, 10);
    const one = (sql, ...a) => this.db.prepare(sql).get(...a);

    const series = [];
    const byDay = new Map(
      this.db
        .prepare(
          `SELECT substr(TransactionDate,1,10) AS day, SUM(Amount) AS revenue FROM "Transaction"
           WHERE TransactionDate >= date('now','-6 days') GROUP BY day`
        )
        .all()
        .map((r) => [r.day, r.revenue])
    );
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      series.push({ day: key, revenue: byDay.get(key) || 0 });
    }

    return {
      machineStatus: statuses,
      machineTotal: this.engine.machines.size,
      zoneCount: this.engine.zones.size,
      queue: { high: this.engine.queue.high.size, normal: this.engine.queue.normal.size },
      sessionStackSize: this.engine.sessions.size,
      activeSessions: one("SELECT COUNT(*) n FROM Session WHERE Status = 'Active'").n,
      sessionsToday: one("SELECT COUNT(*) n FROM Session WHERE Status <> 'Cancelled' AND StartTime >= ?", today).n,
      revenueToday: one('SELECT COALESCE(SUM(Amount),0) v FROM "Transaction" WHERE TransactionDate >= ?', today).v,
      customerCount: one('SELECT COUNT(*) n FROM Customer').n,
      openMaintenance: one("SELECT COUNT(*) n FROM Maintenance WHERE ResolutionStatus <> 'Resolved'").n,
      revenueSeries: series,
      topMachines: this.db
        .prepare(
          `SELECT m.MachineName, COUNT(*) AS Sessions FROM Session s JOIN Machine m ON m.MachineID = s.MachineID
           WHERE s.Status = 'Completed' GROUP BY m.MachineName ORDER BY Sessions DESC, m.MachineName LIMIT 5`
        )
        .all(),
      leaderboard: this.db
        .prepare(
          `SELECT c.FirstName || ' ' || c.LastName AS Player, m.MachineName, s.Score
           FROM Session s JOIN Customer c ON c.CustomerID = s.CustomerID JOIN Machine m ON m.MachineID = s.MachineID
           WHERE s.Status = 'Completed' ORDER BY s.Score DESC LIMIT 5`
        )
        .all(),
    };
  }
}

module.exports = { ArcadeService, MACHINE_STATUSES };

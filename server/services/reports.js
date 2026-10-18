'use strict';
const { isoDate, num } = require('../validate');

/**
 * The eight reporting queries from the original SQL Server lab
 * (database/sqlserver/Arcade_Database.sql), ported to SQLite and made
 * parameterised so they work on live data instead of hard-coded dates.
 */
const today = () => new Date().toISOString().slice(0, 10);
const daysBack = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

function range(q) {
  const from = isoDate(q.from || daysBack(29), 'from');
  const to = isoDate(q.to || today(), 'to');
  return { from, to };
}

const REPORTS = {
  'active-machines': {
    title: 'Operational machines',
    description: 'Machines that can currently be played (not out of order, under maintenance or decommissioned).',
    run: (db) =>
      db
        .prepare(
          `SELECT m.MachineID, m.MachineName, m.GameType, m.CreditCost, z.ZoneName AS Zone, m.Status
           FROM Machine m JOIN Zone z ON z.ZoneID = m.ZoneID
           WHERE m.Status IN ('Available','In Use','Reserved') ORDER BY m.GameType, m.MachineName`
        )
        .all(),
  },
  'customer-usage': {
    title: 'Customer usage',
    description: 'Sessions played and credits spent per customer.',
    run: (db) =>
      db
        .prepare(
          `SELECT c.CustomerID, c.FirstName || ' ' || c.LastName AS Customer,
                  COUNT(s.SessionID) AS TotalSessions, COALESCE(SUM(s.CreditsUsed),0) AS TotalCreditsUsed
           FROM Customer c LEFT JOIN Session s ON s.CustomerID = c.CustomerID AND s.Status <> 'Cancelled'
           GROUP BY c.CustomerID ORDER BY TotalCreditsUsed DESC`
        )
        .all(),
  },
  'popular-machines': {
    title: 'Most popular machines',
    description: 'Machines ranked by number of sessions played.',
    run: (db) =>
      db
        .prepare(
          `SELECT m.MachineID, m.MachineName, COUNT(s.SessionID) AS SessionCount
           FROM Machine m JOIN Session s ON s.MachineID = m.MachineID AND s.Status <> 'Cancelled'
           GROUP BY m.MachineID ORDER BY SessionCount DESC, m.MachineID LIMIT 10`
        )
        .all(),
  },
  'daily-revenue': {
    title: 'Daily revenue',
    description: 'Top-up revenue and credits issued per day (default: last 30 days).',
    params: ['from', 'to'],
    run: (db, q) => {
      const { from, to } = range(q);
      return db
        .prepare(
          `SELECT substr(TransactionDate,1,10) AS Day, COUNT(*) AS Transactions,
                  SUM(Amount) AS Revenue, SUM(CreditsAdded) AS CreditsIssued
           FROM "Transaction" WHERE TransactionDate >= ? AND TransactionDate < date(?, '+1 day')
           GROUP BY Day ORDER BY Day`
        )
        .all(from, to);
    },
  },
  'premium-customers': {
    title: 'Premium customers',
    description: 'Gold / Platinum members holding more than the given credit balance (default 200).',
    params: ['minBalance'],
    run: (db, q) =>
      db
        .prepare(
          `SELECT c.CustomerID, c.FirstName || ' ' || c.LastName AS Customer, m.MembershipType AS Membership,
                  c.CreditBalance, c.RewardPoints
           FROM Customer c JOIN Membership m ON m.MembershipID = c.MembershipID
           WHERE m.MembershipType IN ('Gold','Platinum') AND c.CreditBalance > ? ORDER BY c.CreditBalance DESC`
        )
        .all(q.minBalance === undefined ? 200 : num(q.minBalance, 'minBalance', { min: 0 })),
  },
  'maintenance-active': {
    title: 'Machines under maintenance',
    description: 'Open tickets with the assigned technician.',
    run: (db) =>
      db
        .prepare(
          `SELECT m.MachineID, m.MachineName, mt.IssueDescription AS Issue, mt.StartDate, mt.ResolutionStatus AS Status,
                  e.FirstName || ' ' || e.LastName AS Technician
           FROM Machine m JOIN Maintenance mt ON mt.MachineID = m.MachineID JOIN Employee e ON e.EmployeeID = mt.EmployeeID
           WHERE m.Status = 'Under Maintenance' AND mt.ResolutionStatus <> 'Resolved' ORDER BY mt.StartDate`
        )
        .all(),
  },
  'top-sessions': {
    title: 'Highest-scoring sessions',
    description: 'The top scores ever recorded, with player and machine.',
    run: (db) =>
      db
        .prepare(
          `SELECT s.SessionID, c.FirstName || ' ' || c.LastName AS Player, m.MachineName, s.Score, s.CreditsUsed, s.StartTime
           FROM Session s JOIN Customer c ON c.CustomerID = s.CustomerID JOIN Machine m ON m.MachineID = s.MachineID
           WHERE s.Status = 'Completed' ORDER BY s.Score DESC LIMIT 10`
        )
        .all(),
  },
  'busy-employees': {
    title: 'Busiest employees',
    description: 'Employees who handled 2 or more top-up transactions in the period (default: last 30 days).',
    params: ['from', 'to'],
    run: (db, q) => {
      const { from, to } = range(q);
      return db
        .prepare(
          `SELECT e.EmployeeID, e.FirstName || ' ' || e.LastName AS Employee, e.Role, COUNT(t.TransactionID) AS Transactions
           FROM Employee e JOIN "Transaction" t ON t.EmployeeID = e.EmployeeID
           WHERE t.TransactionDate >= ? AND t.TransactionDate < date(?, '+1 day')
           GROUP BY e.EmployeeID HAVING COUNT(t.TransactionID) >= 2 ORDER BY Transactions DESC`
        )
        .all(from, to);
    },
  },
};

const catalog = () =>
  Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description, params: r.params || [] }));

/** CSV with protection against spreadsheet formula injection. */
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

module.exports = { REPORTS, catalog, toCsv };

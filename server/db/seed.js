'use strict';
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { computeCost } = require('../services/pricing');

// Small deterministic PRNG so the demo data is the same on every machine.
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const iso = (d) => d.toISOString();
const daysAgo = (n, hour, minute = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};

function seedDemoData(db) {
  const rand = lcg(2026);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pwHash = bcrypt.hashSync(cfg.demoPassword, 10);

  const tx = db.transaction(() => {
    // Memberships (from the original SQL Server script)
    const mem = db.prepare('INSERT INTO Membership (MembershipType, DiscountRate, MonthlyFee) VALUES (?,?,?)');
    [['Basic', 0, 0], ['Silver', 5, 500], ['Gold', 10, 1000], ['Platinum', 20, 2000]].forEach((r) => mem.run(...r));

    // Zones
    const zone = db.prepare('INSERT INTO Zone (ZoneName) VALUES (?)');
    ['Zone A', 'Zone B', 'Zone C', 'Zone D'].forEach((z) => zone.run(z));

    // Machines: [zone, name, genre, creditCost, tokenType, status]
    const machine = db.prepare(
      'INSERT INTO Machine (ZoneID, MachineName, GameType, CreditCost, TokenType, Status, InstallDate) VALUES (?,?,?,?,?,?,?)'
    );
    const machines = [
      [1, 'Pac-Man Classic', 'Arcade', 2, 1, 'Available'],
      [1, 'Pac-Man Classic', 'Arcade', 2, 1, 'Available'],
      [1, 'Galaga', 'Arcade', 2, 1, 'Available'],
      [1, 'Pinball Wizard', 'Pinball', 3, 1, 'Reserved'],
      [2, 'Street Fighter IV', 'Fighting', 3, 2, 'Available'],
      [2, 'Tekken 7', 'Fighting', 3, 2, 'Under Maintenance'],
      [2, 'Mortal Kombat 11', 'Fighting', 3, 2, 'Available'],
      [3, 'Dance Dance Revolution', 'Rhythm', 4, 2, 'Under Maintenance'],
      [3, 'Beatmania', 'Rhythm', 3, 1, 'Available'],
      [4, 'Daytona USA', 'Racing', 4, 3, 'Available'],
      [4, 'Daytona USA', 'Racing', 4, 3, 'Available'],
      [4, 'Time Crisis', 'Shooter', 3, 2, 'Out of Order'],
      [4, 'Air Hockey', 'Sports', 2, 1, 'Available'],
    ];
    machines.forEach((m, i) => machine.run(...m, iso(daysAgo(120 - i * 3, 9)).slice(0, 10)));

    // Employees (+ demo logins)
    const emp = db.prepare(
      'INSERT INTO Employee (FirstName, LastName, Role, Shift, Salary, Phone, Username, PasswordHash) VALUES (?,?,?,?,?,?,?,?)'
    );
    emp.run('Ahmed', 'Raza', 'Manager', 'Morning', 80000, '0333-9999999', 'manager', pwHash);
    emp.run('Bilal', 'Akram', 'Cashier', 'Evening', 45000, '0344-8888888', 'cashier', pwHash);
    emp.run('Kamran', 'Tariq', 'Technician', 'Morning', 55000, '0355-7777777', 'technician', pwHash);
    emp.run('Hina', 'Malik', 'Security', 'Night', 40000, '0366-6666666', 'security', pwHash);

    // Customers: [membershipId, first, last, phone, email, credits, points]
    const cust = db.prepare(
      'INSERT INTO Customer (MembershipID, FirstName, LastName, Phone, Email, CreditBalance, RewardPoints, JoinDate) VALUES (?,?,?,?,?,?,?,?)'
    );
    [
      [1, 'Ali', 'Hassan', '0300-1234567', 'ali@example.com', 130, 55],
      [3, 'Sara', 'Khan', '0311-7654321', 'sara@example.com', 470, 205],
      [2, 'Umar', 'Sheikh', '0321-1122334', 'umar@example.com', 75, 30],
      [4, 'Ayesha', 'Noor', '0332-5558899', 'ayesha@example.com', 640, 320],
      [1, 'Hamza', 'Iqbal', '0345-1239876', 'hamza@example.com', 40, 10],
      [3, 'Zainab', 'Malik', '0301-4443322', 'zainab@example.com', 320, 120],
    ].forEach((c, i) => cust.run(...c, iso(daysAgo(90 - i * 10, 12)).slice(0, 10)));

    // Top-up transactions over the last 14 days (cashier = employee 2, manager = 1)
    const trx = db.prepare(
      'INSERT INTO "Transaction" (CustomerID, EmployeeID, Amount, PaymentMethod, TransactionDate, CreditsAdded) VALUES (?,?,?,?,?,?)'
    );
    for (let d = 13; d >= 0; d--) {
      const count = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < count; k++) {
        const amount = pick([100, 200, 300, 500, 800]);
        trx.run(
          1 + Math.floor(rand() * 6),
          pick([1, 2, 2, 2]),
          amount,
          pick(['Cash', 'Cash', 'Card', 'Online']),
          iso(daysAgo(d, 10 + Math.floor(rand() * 10), Math.floor(rand() * 60))),
          Math.floor(amount / cfg.pkrPerCredit)
        );
      }
    }

    // Completed session history over the last 14 days
    const discountByCustomer = { 1: 0, 2: 10, 3: 5, 4: 20, 5: 0, 6: 10 };
    const playable = machines
      .map((m, i) => ({ id: i + 1, cost: m[3] }))
      .filter((m) => ![6, 8, 12].includes(m.id));
    const ses = db.prepare(
      `INSERT INTO Session (CustomerID, MachineID, StartTime, EndTime, PlannedMinutes, CreditsUsed, Score, Status)
       VALUES (?,?,?,?,?,?,?, 'Completed')`
    );
    for (let d = 13; d >= 0; d--) {
      const count = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < count; k++) {
        const cid = 1 + Math.floor(rand() * 6);
        const m = pick(playable);
        const minutes = pick([10, 15, 20, 30, 45]);
        const start = daysAgo(d, 11 + k * 2, Math.floor(rand() * 40));
        const end = new Date(start.getTime() + minutes * 60000);
        const credits = computeCost({ creditCost: m.cost, minutes, discountRate: discountByCustomer[cid] });
        ses.run(cid, m.id, iso(start), iso(end), minutes, credits, Math.floor(1000 + rand() * 19000));
      }
    }
    // Maintenance tickets for the two machines under maintenance
    const mnt = db.prepare(
      `INSERT INTO Maintenance (MachineID, EmployeeID, IssueDescription, StartDate, ResolutionStatus) VALUES (?,?,?,?,?)`
    );
    mnt.run(6, 3, 'Joystick unresponsive on Player 2 side', iso(daysAgo(3, 9)).slice(0, 10), 'In Progress');
    mnt.run(8, 3, 'Dance pad arrows sticking', iso(daysAgo(1, 9)).slice(0, 10), 'Open');
    // One resolved historical ticket
    db.prepare(
      `INSERT INTO Maintenance (MachineID, EmployeeID, IssueDescription, StartDate, EndDate, ResolutionStatus)
       VALUES (10, 3, 'Steering wheel force-feedback motor replaced', ?, ?, 'Resolved')`
    ).run(iso(daysAgo(9, 9)).slice(0, 10), iso(daysAgo(7, 9)).slice(0, 10));
  });
  tx();
}

module.exports = { seedDemoData };

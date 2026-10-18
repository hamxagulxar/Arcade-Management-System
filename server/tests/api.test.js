'use strict';
process.env.NODE_ENV = 'test';
process.env.LOGIN_RATE_MAX = '1000';
process.env.DEMO_PASSWORD = 'test-pass-123';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');

let server;
let base;
let ctx;
const tokens = {};

async function call(method, path, { body, as = 'manager', raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  ctx = createApp({ dbPath: ':memory:', seed: true });
  await new Promise((resolve) => { server = ctx.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const u of ['manager', 'cashier', 'technician', 'security']) {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'test-pass-123' }),
    });
    tokens[u] = (await res.json()).token;
  }
});
test.after(() => { server.close(); ctx.db.close(); });

test('auth: rejects bad credentials and unauthenticated calls', async () => {
  const bad = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: 'wrong-password' }),
  });
  assert.equal(bad.status, 401);
  assert.equal((await call('GET', '/zones', { as: null })).status, 401);
});

test('RBAC: cashier cannot modify machines, security cannot start sessions', async () => {
  const machine = await call('PATCH', '/machines/1', { as: 'cashier', body: { status: 'Reserved' } });
  assert.equal(machine.status, 403);
  const sess = await call('POST', '/sessions', { as: 'security', body: { customerId: 1, machineId: 1, minutes: 10 } });
  assert.equal(sess.status, 403);
  assert.equal((await call('GET', '/employees', { as: 'cashier' })).status, 403);
});

test('zones list machines in ID order and the tree view is balanced', async () => {
  const { body } = await call('GET', '/zones');
  assert.equal(body.length, 4);
  for (const z of body) {
    const ids = z.machines.map((x) => x.MachineID);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  }
  const tree = await call('GET', '/zones/4/tree');
  assert.equal(tree.status, 200);
  assert.ok(tree.body.height <= 3);
});

test('priority queue: Gold/Platinum auto-prioritised; high served before normal', async () => {
  // customer 1 = Basic (Normal), customer 2 = Gold (High)
  const normal = await call('POST', '/tokens', { as: 'cashier', body: { customerId: 1, game: 'Galaga', sessionMinutes: 10 } });
  const high = await call('POST', '/tokens', { as: 'cashier', body: { customerId: 2, game: 'Galaga', sessionMinutes: 10 } });
  assert.equal(normal.body.Priority, 'Normal');
  assert.equal(high.body.Priority, 'High');

  const q = (await call('GET', '/tokens/queue')).body;
  assert.equal(q.high[0].RequestID, high.body.RequestID);

  // Only ONE Galaga cabinet exists, so processing everything serves the High request first
  // and the Normal one keeps waiting.
  const out = (await call('POST', '/tokens/process-all', { as: 'cashier' })).body;
  const byReq = Object.fromEntries(out.results.map((r) => [r.requestId, r.outcome]));
  assert.equal(byReq[high.body.RequestID], 'assigned');
  assert.equal(byReq[normal.body.RequestID], 'waiting');
  assert.equal(out.queue.normal.length, 1);
});

test('one session per machine, sufficient credits required', async () => {
  // Galaga (machine 3) is now In Use from the previous test
  const busy = await call('POST', '/sessions', { as: 'cashier', body: { customerId: 3, machineId: 3, minutes: 10 } });
  assert.equal(busy.status, 409);
  // Hamza (5) has 40 credits: a 240-minute session on Daytona (cost 4/block) needs far more
  const broke = await call('POST', '/sessions', { as: 'cashier', body: { customerId: 5, machineId: 10, minutes: 240 } });
  assert.equal(broke.status, 400);
  assert.match(broke.body.error, /Insufficient credits/);
  // Machines under maintenance cannot be played
  const maint = await call('POST', '/sessions', { as: 'cashier', body: { customerId: 2, machineId: 6, minutes: 10 } });
  assert.equal(maint.status, 409);
});

test('end session frees the machine; stack rollback refunds credits', async () => {
  const before = (await call('GET', '/customers/2', { as: 'cashier' })).body;
  const stack = (await call('GET', '/sessions/stack')).body;
  const top = stack.items[0];
  assert.equal(top.Status, 'Active');

  const ended = await call('POST', `/sessions/${top.SessionID}/end`, { as: 'cashier', body: { score: 12345 } });
  assert.equal(ended.status, 200);
  const machines = (await call('GET', '/machines')).body;
  assert.equal(machines.find((m) => m.MachineID === top.MachineID).Status, 'Available');

  const rb = await call('POST', '/sessions/rollback');
  assert.equal(rb.status, 200);
  assert.equal(rb.body.refunded, top.CreditsUsed);
  const after = (await call('GET', '/customers/2', { as: 'cashier' })).body;
  assert.equal(after.CreditBalance, before.CreditBalance + top.CreditsUsed);
  assert.notEqual((await call('GET', '/sessions/stack')).body.items[0].SessionID, top.SessionID);
});

test('top-up converts rupees to credits and records the cashier', async () => {
  const before = (await call('GET', '/customers/5', { as: 'cashier' })).body.CreditBalance;
  const res = await call('POST', '/customers/5/topup', { as: 'cashier', body: { amount: 200, paymentMethod: 'Cash' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.CreditBalance, before + 100);
  const bad = await call('POST', '/customers/5/topup', { as: 'cashier', body: { amount: -5 } });
  assert.equal(bad.status, 400);
});

test('maintenance ticket locks the machine and resolving releases it', async () => {
  const open = await call('POST', '/maintenance', { as: 'technician', body: { machineId: 13, issueDescription: 'Puck dispenser jammed' } });
  assert.equal(open.status, 201);
  let m = (await call('GET', '/machines')).body.find((x) => x.MachineID === 13);
  assert.equal(m.Status, 'Under Maintenance');
  const manual = await call('PATCH', '/machines/13', { body: { status: 'Available' } });
  assert.equal(manual.status, 409, 'must resolve the ticket instead of flipping the status by hand');
  const done = await call('PATCH', `/maintenance/${open.body.MaintenanceID}`, { as: 'technician', body: { resolutionStatus: 'Resolved' } });
  assert.equal(done.status, 200);
  m = (await call('GET', '/machines')).body.find((x) => x.MachineID === 13);
  assert.equal(m.Status, 'Available');
});

test('reports run and CSV export neutralises formula injection', async () => {
  const names = (await call('GET', '/reports')).body.map((r) => r.key);
  assert.equal(names.length, 8);
  for (const key of names) {
    const r = await call('GET', `/reports/${key}`);
    assert.equal(r.status, 200, key);
    assert.ok(Array.isArray(r.body.rows));
  }
  const reg = await call('POST', '/customers', { as: 'cashier', body: { firstName: '=HYPERLINK("x")', lastName: 'Test', phone: '0399-0000001' } });
  assert.equal(reg.status, 201);
  const bad = await call('GET', '/reports/daily-revenue?from=nonsense');
  assert.equal(bad.status, 400);
  const csv = await (await call('GET', '/reports/customer-usage?format=csv', { raw: true })).text();
  assert.match(csv, /'=HYPERLINK/);
});

test('dashboard counts match the data structures', async () => {
  const d = (await call('GET', '/dashboard')).body;
  const total = Object.values(d.machineStatus).reduce((a, b) => a + b, 0);
  assert.equal(total, d.machineTotal);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MachineTree } = require('../dsa/MachineTree');
const { ZoneList } = require('../dsa/ZoneList');
const { PriorityTokenQueue } = require('../dsa/PriorityTokenQueue');
const { SessionStack } = require('../dsa/SessionStack');

const m = (id, extra = {}) => ({ MachineID: id, MachineName: `M${id}`, GameType: 'Arcade', Status: 'Available', ...extra });

test('MachineTree: in-order traversal is sorted and duplicates are skipped', () => {
  const t = new MachineTree();
  [50, 20, 70, 10, 30, 60, 80].forEach((id) => assert.equal(t.insert(m(id)), true));
  assert.equal(t.insert(m(30)), false, 'duplicate ID must be rejected');
  assert.equal(t.size, 7);
  assert.deepEqual(t.inOrder().map((x) => x.MachineID), [10, 20, 30, 50, 60, 70, 80]);
});

test('MachineTree: stays balanced when IDs arrive in ascending order', () => {
  const t = new MachineTree();
  for (let i = 1; i <= 1023; i++) t.insert(m(i));
  assert.equal(t.size, 1023);
  assert.ok(t.height <= 11, `height ${t.height} should be ~log2(n), not n`);
  assert.equal(t.find(777).MachineID, 777);
  assert.equal(t.find(5000), null);
});

test('MachineTree: findFirst honours in-order and countByStatus aggregates', () => {
  const t = new MachineTree();
  t.insert(m(3, { Status: 'In Use' }));
  t.insert(m(1, { Status: 'Available' }));
  t.insert(m(2, { Status: 'Available' }));
  assert.equal(t.findFirst((x) => x.Status === 'Available').MachineID, 1);
  assert.deepEqual(t.countByStatus(), { Available: 2, 'In Use': 1 });
  assert.equal(t.findFirst((x) => x.Status === 'Reserved'), null);
});

test('ZoneList: append, find, remove (head, middle, tail)', () => {
  const l = new ZoneList();
  ['A', 'B', 'C', 'D'].forEach((n, i) => l.append({ ZoneID: i + 1, ZoneName: `Zone ${n}` }));
  assert.equal(l.size, 4);
  assert.equal(l.findByName('zone c').zone.ZoneID, 3);
  assert.equal(l.remove(2), true);
  assert.equal(l.remove(4), true); // tail
  assert.equal(l.remove(1), true); // head
  assert.deepEqual(l.toArray().map((n) => n.zone.ZoneID), [3]);
  l.append({ ZoneID: 9, ZoneName: 'Zone X' });
  assert.deepEqual(l.toArray().map((n) => n.zone.ZoneID), [3, 9]);
  assert.equal(l.remove(42), false);
});

test('PriorityTokenQueue: high before normal, FIFO within a level', () => {
  const q = new PriorityTokenQueue();
  q.enqueue({ RequestID: 1, Priority: 'Normal' });
  q.enqueue({ RequestID: 2, Priority: 'High' });
  q.enqueue({ RequestID: 3, Priority: 'Normal' });
  q.enqueue({ RequestID: 4, Priority: 'High' });
  assert.equal(q.size, 4);
  assert.deepEqual(q.toArray().map((r) => r.RequestID), [2, 4, 1, 3]);
  assert.equal(q.dequeue().RequestID, 2);
  assert.equal(q.remove(1).RequestID, 1);
  assert.deepEqual([q.dequeue().RequestID, q.dequeue().RequestID], [4, 3]);
  assert.equal(q.dequeue(), null);
  assert.equal(q.size, 0);
});

test('SessionStack: LIFO push/pop/peek', () => {
  const s = new SessionStack();
  assert.equal(s.pop(), null);
  s.push({ SessionID: 1 });
  s.push({ SessionID: 2 });
  assert.equal(s.peek().SessionID, 2);
  assert.deepEqual(s.toArray().map((x) => x.SessionID), [2, 1]);
  assert.equal(s.pop().SessionID, 2);
  assert.equal(s.size, 1);
});

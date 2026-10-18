'use strict';
const { ZoneList } = require('./ZoneList');
const { PriorityTokenQueue } = require('./PriorityTokenQueue');
const { SessionStack } = require('./SessionStack');

/**
 * ArcadeEngine — the in-memory data-structure layer.
 *
 *   zones     -> ZoneList (linked list) -> each node owns a MachineTree (AVL BST)
 *   queue     -> PriorityTokenQueue (two linked-list queues)
 *   sessions  -> SessionStack (linked-list stack)
 *
 * The SQL database is the source of truth. The engine is rebuilt from it at
 * startup (hydrate) and kept in sync by ArcadeService after every write.
 */
class ArcadeEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.zones = new ZoneList();
    this.queue = new PriorityTokenQueue();
    this.sessions = new SessionStack();
    this.machines = new Map(); // MachineID -> machine object (shared with tree nodes)
  }

  hydrate(db) {
    this.reset();
    for (const z of db.prepare('SELECT ZoneID, ZoneName FROM Zone ORDER BY ZoneID').all()) {
      this.zones.append(z);
    }
    for (const m of db.prepare('SELECT * FROM Machine ORDER BY MachineID').all()) {
      this.addMachine(m);
    }
    const waiting = db
      .prepare(
        `SELECT t.*, c.FirstName || ' ' || c.LastName AS CustomerName
         FROM TokenRequest t JOIN Customer c ON c.CustomerID = t.CustomerID
         WHERE t.Status = 'Waiting' ORDER BY t.RequestID`
      )
      .all();
    for (const r of waiting) this.queue.enqueue(r);

    const sessions = db
      .prepare(
        `SELECT s.SessionID, s.CustomerID, s.MachineID, s.PlannedMinutes, s.CreditsUsed, s.Status,
                s.StartTime, s.Score,
                c.FirstName || ' ' || c.LastName AS CustomerName, m.MachineName
         FROM Session s
         JOIN Customer c ON c.CustomerID = s.CustomerID
         JOIN Machine m ON m.MachineID = s.MachineID
         WHERE s.Status <> 'Cancelled' ORDER BY s.StartTime, s.SessionID`
      )
      .all();
    for (const s of sessions) this.sessions.push(s);
    return this;
  }

  addMachine(machine) {
    const node = this.zones.findById(machine.ZoneID);
    if (!node) throw new Error(`Zone ${machine.ZoneID} not found`);
    if (!node.tree.insert(machine)) return false;
    this.machines.set(machine.MachineID, machine);
    return true;
  }

  getMachine(id) {
    return this.machines.get(id) || null;
  }

  /** First available machine matching a game name or genre, scanning zones in list order. */
  findAvailableMachine(game) {
    const key = String(game).trim().toLowerCase();
    const match = (m) =>
      m.Status === 'Available' &&
      (m.MachineName.toLowerCase() === key || m.GameType.toLowerCase() === key);
    for (const zn of this.zones) {
      const m = zn.tree.findFirst(match);
      if (m) return m;
    }
    return null;
  }

  /** All non-decommissioned machines matching a game name or genre. */
  matchingMachines(game) {
    const key = String(game).trim().toLowerCase();
    const out = [];
    for (const zn of this.zones) {
      for (const m of zn.tree.inOrder()) {
        if (m.Status === 'Decommissioned') continue;
        if (m.MachineName.toLowerCase() === key || m.GameType.toLowerCase() === key) out.push(m);
      }
    }
    return out;
  }

  statusCounts() {
    const counts = {};
    for (const zn of this.zones) zn.tree.countByStatus(counts);
    return counts;
  }
}

module.exports = { ArcadeEngine };

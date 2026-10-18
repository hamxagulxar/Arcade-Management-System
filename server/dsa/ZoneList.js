'use strict';
const { MachineTree } = require('./MachineTree');

/**
 * ZoneList — singly linked list of zones. Each node owns a MachineTree.
 * (The C++ version inserted at the head; here zones are appended so the UI
 * lists them in creation order. Insertion at the head is also available.)
 */
class ZoneNode {
  constructor(zone) {
    this.zone = zone; // { ZoneID, ZoneName }
    this.tree = new MachineTree();
    this.next = null;
  }
}

class ZoneList {
  constructor() {
    this.head = null;
    this.tail = null;
    this.size = 0;
  }

  prepend(zone) {
    const node = new ZoneNode(zone);
    node.next = this.head;
    this.head = node;
    if (!this.tail) this.tail = node;
    this.size += 1;
    return node;
  }

  append(zone) {
    const node = new ZoneNode(zone);
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.size += 1;
    return node;
  }

  findById(id) {
    for (let n = this.head; n; n = n.next) if (n.zone.ZoneID === id) return n;
    return null;
  }

  findByName(name) {
    const key = String(name).trim().toLowerCase();
    for (let n = this.head; n; n = n.next) if (n.zone.ZoneName.toLowerCase() === key) return n;
    return null;
  }

  remove(id) {
    let prev = null;
    for (let n = this.head; n; prev = n, n = n.next) {
      if (n.zone.ZoneID !== id) continue;
      if (prev) prev.next = n.next;
      else this.head = n.next;
      if (n === this.tail) this.tail = prev;
      this.size -= 1;
      return true;
    }
    return false;
  }

  *[Symbol.iterator]() {
    for (let n = this.head; n; n = n.next) yield n;
  }

  toArray() {
    return [...this];
  }
}

module.exports = { ZoneList, ZoneNode };

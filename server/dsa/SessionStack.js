'use strict';

/**
 * SessionStack — LIFO stack of play sessions built on a linked list.
 * push() records a new session, pop() rolls back the most recent one
 * (cancel + refund), exactly like the C++ SessionStack.
 */
class SNode {
  constructor(record) {
    this.record = record;
    this.next = null;
  }
}

class SessionStack {
  constructor() {
    this.top = null;
    this.size = 0;
  }

  push(record) {
    const node = new SNode(record);
    node.next = this.top;
    this.top = node;
    this.size += 1;
    return record;
  }

  pop() {
    if (!this.top) return null;
    const node = this.top;
    this.top = node.next;
    this.size -= 1;
    return node.record;
  }

  peek() {
    return this.top ? this.top.record : null;
  }

  /** Most recent first. */
  toArray() {
    const out = [];
    for (let n = this.top; n; n = n.next) out.push(n.record);
    return out;
  }
}

module.exports = { SessionStack };

'use strict';

/**
 * PriorityTokenQueue — two FIFO queues built on linked lists.
 * High-priority requests (premium members / tournament) are always served
 * before normal ones; within a priority level it is strictly first-come,
 * first-served. Same design as the C++ TokenRequestQueue.
 */
class QNode {
  constructor(request) {
    this.request = request;
    this.next = null;
  }
}

class LinkedQueue {
  constructor() {
    this.front = null;
    this.rear = null;
    this.size = 0;
  }

  enqueue(request) {
    const node = new QNode(request);
    if (this.rear) this.rear.next = node;
    else this.front = node;
    this.rear = node;
    this.size += 1;
  }

  dequeue() {
    if (!this.front) return null;
    const node = this.front;
    this.front = node.next;
    if (!this.front) this.rear = null;
    this.size -= 1;
    return node.request;
  }

  remove(requestId) {
    let prev = null;
    for (let n = this.front; n; prev = n, n = n.next) {
      if (n.request.RequestID !== requestId) continue;
      if (prev) prev.next = n.next;
      else this.front = n.next;
      if (n === this.rear) this.rear = prev;
      this.size -= 1;
      return n.request;
    }
    return null;
  }

  toArray() {
    const out = [];
    for (let n = this.front; n; n = n.next) out.push(n.request);
    return out;
  }
}

class PriorityTokenQueue {
  constructor() {
    this.high = new LinkedQueue();
    this.normal = new LinkedQueue();
  }

  enqueue(request) {
    (request.Priority === 'High' ? this.high : this.normal).enqueue(request);
  }

  dequeue() {
    return this.high.dequeue() || this.normal.dequeue();
  }

  peek() {
    return (this.high.front || this.normal.front || {}).request || null;
  }

  remove(requestId) {
    return this.high.remove(requestId) || this.normal.remove(requestId);
  }

  get size() {
    return this.high.size + this.normal.size;
  }

  /** Service order: all high-priority requests, then all normal ones. */
  toArray() {
    return [...this.high.toArray(), ...this.normal.toArray()];
  }
}

module.exports = { PriorityTokenQueue };

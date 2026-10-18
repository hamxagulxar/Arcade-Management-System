'use strict';

/**
 * MachineTree — a self-balancing binary search tree (AVL) keyed by MachineID.
 *
 * The original C++ prototype used a plain BST per zone. Machine IDs arrive in
 * ascending order (auto-increment), which degrades a plain BST into a linked
 * list (O(n) lookups). AVL rotations keep the height at O(log n) while keeping
 * the exact same BST semantics: in-order traversal yields machines sorted by ID.
 */
class TreeNode {
  constructor(machine) {
    this.machine = machine; // shared reference with the engine's machine index
    this.left = null;
    this.right = null;
    this.height = 1;
  }
}

const h = (n) => (n ? n.height : 0);
const update = (n) => { n.height = 1 + Math.max(h(n.left), h(n.right)); };
const balanceFactor = (n) => h(n.left) - h(n.right);

function rotateRight(y) {
  const x = y.left;
  y.left = x.right;
  x.right = y;
  update(y);
  update(x);
  return x;
}

function rotateLeft(x) {
  const y = x.right;
  x.right = y.left;
  y.left = x;
  update(x);
  update(y);
  return y;
}

function rebalance(n) {
  update(n);
  const bf = balanceFactor(n);
  if (bf > 1) {
    if (balanceFactor(n.left) < 0) n.left = rotateLeft(n.left);
    return rotateRight(n);
  }
  if (bf < -1) {
    if (balanceFactor(n.right) > 0) n.right = rotateRight(n.right);
    return rotateLeft(n);
  }
  return n;
}

class MachineTree {
  constructor() {
    this.root = null;
    this.size = 0;
  }

  /** Insert a machine. Returns false (and skips) if the ID already exists. */
  insert(machine) {
    let inserted = false;
    const ins = (node) => {
      if (!node) {
        inserted = true;
        return new TreeNode(machine);
      }
      if (machine.MachineID < node.machine.MachineID) node.left = ins(node.left);
      else if (machine.MachineID > node.machine.MachineID) node.right = ins(node.right);
      else return node; // duplicate ID -> skipped, like the C++ version
      return rebalance(node);
    };
    this.root = ins(this.root);
    if (inserted) this.size += 1;
    return inserted;
  }

  find(id) {
    let n = this.root;
    while (n) {
      if (id === n.machine.MachineID) return n.machine;
      n = id < n.machine.MachineID ? n.left : n.right;
    }
    return null;
  }

  /** Iterative in-order traversal (sorted by MachineID). */
  inOrder() {
    const out = [];
    const stack = [];
    let n = this.root;
    while (n || stack.length) {
      while (n) {
        stack.push(n);
        n = n.left;
      }
      n = stack.pop();
      out.push(n.machine);
      n = n.right;
    }
    return out;
  }

  /** First machine (in ID order) that satisfies the predicate, or null. */
  findFirst(predicate) {
    const stack = [];
    let n = this.root;
    while (n || stack.length) {
      while (n) {
        stack.push(n);
        n = n.left;
      }
      n = stack.pop();
      if (predicate(n.machine)) return n.machine;
      n = n.right;
    }
    return null;
  }

  /** Counts machines by status — the recursive count from the C++ version. */
  countByStatus(acc = {}) {
    for (const m of this.inOrder()) acc[m.Status] = (acc[m.Status] || 0) + 1;
    return acc;
  }

  get height() {
    return h(this.root);
  }

  /** Plain-object snapshot of the tree shape, used by the frontend tree view. */
  toJSON() {
    const walk = (n) =>
      n
        ? {
            id: n.machine.MachineID,
            name: n.machine.MachineName,
            status: n.machine.Status,
            left: walk(n.left),
            right: walk(n.right),
          }
        : null;
    return walk(this.root);
  }
}

module.exports = { MachineTree };

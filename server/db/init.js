'use strict';
/* Usage:  node server/db/init.js            -> create schema (+ demo data if DB is empty)
 *         node server/db/init.js --reset    -> delete the DB file and rebuild from scratch */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { openDb } = require('./connection');
const { seedDemoData } = require('./seed');

function initDb(db, { seed = cfg.seedDemoData } = {}) {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const empty = db.prepare('SELECT COUNT(*) AS n FROM Employee').get().n === 0;
  if (seed && empty) seedDemoData(db);
  return db;
}

module.exports = { initDb };

if (require.main === module) {
  if (process.argv.includes('--reset') && cfg.dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cfg.dbPath + suffix, { force: true });
    console.log('Removed existing database.');
  }
  const db = initDb(openDb(cfg.dbPath), { seed: true });
  const counts = ['Zone', 'Machine', 'Customer', 'Employee', 'Session', '"Transaction"']
    .map((t) => `${t.replace(/"/g, '')}: ${db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n}`)
    .join(' | ');
  console.log(`Database ready at ${cfg.dbPath}\n${counts}`);
  db.close();
}

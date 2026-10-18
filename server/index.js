'use strict';
const cfg = require('./config');
const { createApp } = require('./app');

const { app, db } = createApp();
const server = app.listen(cfg.port, () => {
  console.log(`\n  Arcade Management System running at http://localhost:${cfg.port}`);
  if (cfg.seedDemoData) {
    console.log('  Demo logins (password "%s"): manager | cashier | technician | security', cfg.demoPassword);
    console.log('  Change these passwords before exposing the app to a network!\n');
  }
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

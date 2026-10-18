'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cfg = require('./config');
const { openDb } = require('./db/connection');
const { initDb } = require('./db/init');
const { ArcadeService } = require('./services/arcadeService');
const { ApiError } = require('./errors');
const buildRouter = require('./routes');

function createApp({ dbPath = cfg.dbPath, seed = cfg.seedDemoData } = {}) {
  const db = initDb(openDb(dbPath), { seed });
  const service = new ArcadeService(db);
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '50kb' }));

  app.use('/api', buildRouter(service, db));
  app.use(express.static(path.join(__dirname, '..', 'client'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return { app, db, service };
}

module.exports = { createApp };

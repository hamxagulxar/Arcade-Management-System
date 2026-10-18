'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const isProd = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
  // Dev convenience: random secret per process (logins reset on every restart).
  jwtSecret = crypto.randomBytes(32).toString('hex');
}

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'arcade.db'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  cookieName: 'arcade_token',
  loginRateMax: Number(process.env.LOGIN_RATE_MAX) || 20,
  seedDemoData: process.env.SEED_DEMO_DATA !== 'false',
  demoPassword: process.env.DEMO_PASSWORD || 'arcade123',
  // Business rules
  minutesPerBlock: 5, // CreditCost is charged per block of this many minutes
  pkrPerCredit: 2, // top-up exchange rate (Rs per credit)
  pointsPerCredits: 4, // 1 reward point per N credits spent
};

'use strict';
const cfg = require('../config');

/** Credits needed for a session: ceil(minutes / block) * cost, minus membership discount. */
function computeCost({ creditCost, minutes, discountRate = 0 }) {
  const blocks = Math.ceil(minutes / cfg.minutesPerBlock);
  const base = blocks * creditCost;
  return Math.max(1, Math.ceil(base * (1 - discountRate / 100)));
}

const rewardPointsFor = (creditsUsed) => Math.floor(creditsUsed / cfg.pointsPerCredits);

module.exports = { computeCost, rewardPointsFor };

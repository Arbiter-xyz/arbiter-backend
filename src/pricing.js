'use strict';

/**
 * Pricing helpers.
 *
 * `surgeMultiplier()` is a pure function of an aggregate input (current load)
 * and is intentionally easy to unit-test in isolation. The loyalty tier
 * helpers below follow the same shape: they are pure functions of a payer's
 * spend summary (as produced by `summarizePayerQuestions()` in payerIndex.js)
 * and return the applicable bonus credit for that summary.
 */

const SURGE_TIERS = [
  { minLoad: 0.9, multiplier: 3 },
  { minLoad: 0.75, multiplier: 2 },
  { minLoad: 0.5, multiplier: 1.5 },
];

function surgeMultiplier(load) {
  const normalized = Number.isFinite(load) ? load : 0;
  for (const tier of SURGE_TIERS) {
    if (normalized >= tier.minLoad) {
      return tier.multiplier;
    }
  }
  return 1;
}

/**
 * Loyalty tiers, ordered from highest to lowest so the first match wins.
 *
 * A tier is crossed when the payer's lifetime spend (in stroops) reaches
 * `minSpendStroops` AND their success rate is at least `minSuccessRate`.
 * `bonusStroops` is the one-time credit granted for crossing the tier.
 */
const LOYALTY_TIERS = [
  { name: 'platinum', minSpendStroops: 10000000000, minSuccessRate: 0.95, bonusStroops: 5000000 },
  { name: 'gold', minSpendStroops: 1000000000, minSuccessRate: 0.9, bonusStroops: 1000000 },
  { name: 'silver', minSpendStroops: 100000000, minSuccessRate: 0.8, bonusStroops: 100000 },
  { name: 'bronze', minSpendStroops: 10000000, minSuccessRate: 0.5, bonusStroops: 10000 },
];

/**
 * Pure tier evaluation. Takes a payer's spend summary (the shape returned by
 * `summarizePayerQuestions()`) and returns the applicable loyalty tier plus
 * the bonus credit for that tier. Payers below every threshold get the
 * `none` tier with a zero bonus.
 *
 * @param {{ totalSpendStroops?: number, successRate?: number }} summary
 * @returns {{ tier: string, bonusStroops: number, minSpendStroops: number, minSuccessRate: number }}
 */
function evaluateLoyaltyTier(summary) {
  const totalSpendStroops = Number.isFinite(summary && summary.totalSpendStroops)
    ? summary.totalSpendStroops
    : 0;
  const successRate = Number.isFinite(summary && summary.successRate)
    ? summary.successRate
    : 0;

  for (const tier of LOYALTY_TIERS) {
    if (totalSpendStroops >= tier.minSpendStroops && successRate >= tier.minSuccessRate) {
      return {
        tier: tier.name,
        bonusStroops: tier.bonusStroops,
        minSpendStroops: tier.minSpendStroops,
        minSuccessRate: tier.minSuccessRate,
      };
    }
  }

  return {
    tier: 'none',
    bonusStroops: 0,
    minSpendStroops: 0,
    minSuccessRate: 0,
  };
}

/**
 * Returns the ordered list of tier names a payer has crossed, lowest first.
 * Used to track which threshold crossings have already been credited so a
 * repeated evaluation does not double-credit the same crossing.
 *
 * @param {{ totalSpendStroops?: number, successRate?: number }} summary
 * @returns {string[]}
 */
function crossedLoyaltyTiers(summary) {
  const totalSpendStroops = Number.isFinite(summary && summary.totalSpendStroops)
    ? summary.totalSpendStroops
    : 0;
  const successRate = Number.isFinite(summary && summary.successRate)
    ? summary.successRate
    : 0;

  return LOYALTY_TIERS
    .filter((tier) => totalSpendStroops >= tier.minSpendStroops && successRate >= tier.minSuccessRate)
    .map((tier) => tier.name)
    .reverse();
}

/**
 * Given a payer's spend summary and the set of tiers already credited, returns
 * the tiers that are newly crossed and still need crediting. This is the
 * idempotency guard: callers persist the returned tiers after crediting so a
 * subsequent evaluation of the same summary yields an empty list.
 *
 * @param {{ totalSpendStroops?: number, successRate?: number }} summary
 * @param {Iterable<string>} [alreadyCredited]
 * @returns {Array<{ tier: string, bonusStroops: number }>}
 */
function pendingLoyaltyRewards(summary, alreadyCredited) {
  const credited = new Set(alreadyCredited || []);
  const crossed = crossedLoyaltyTiers(summary);

  return crossed
    .filter((name) => !credited.has(name))
    .map((name) => {
      const tier = LOYALTY_TIERS.find((candidate) => candidate.name === name);
      return { tier: name, bonusStroops: tier ? tier.bonusStroops : 0 };
    });
}

module.exports = {
  surgeMultiplier,
  LOYALTY_TIERS,
  evaluateLoyaltyTier,
  crossedLoyaltyTiers,
  pendingLoyaltyRewards,
};

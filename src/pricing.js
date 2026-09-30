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
const COMFORTABLE_SUPPLY_MULTIPLE = 3;
// Exported so callers that must reserve funds *before* the live price is
// known (billing.js's fiat-credit reservation, made ahead of askMetered()
// computing the real surge-adjusted price) can compute a safe ceiling —
// see reserveCredit()'s doc comment in billing.js.
export const MAX_SURGE_MULTIPLIER = 2;
const MIN_SURGE_MULTIPLIER = 1;

export function surgeMultiplier(tier, onlineWorkers) {
  const comfortable = tier.quorumSize * COMFORTABLE_SUPPLY_MULTIPLE;
  if (comfortable <= 0 || onlineWorkers >= comfortable) return MIN_SURGE_MULTIPLIER;
  const scarcity = 1 - onlineWorkers / comfortable; // 0 (comfortable supply) .. 1 (nobody online)
  const raw = MIN_SURGE_MULTIPLIER + scarcity * (MAX_SURGE_MULTIPLIER - MIN_SURGE_MULTIPLIER);
  return Math.round(raw * 100) / 100;
}

/**
 * Volume discount tiers (issue #107). Surge pricing above is about *when*
 * you ask (worker supply); this is about *who* is asking — a customer-specific
 * multiplier derived from an account's lifetime usage volume, so a payer who
 * has asked ten thousand questions doesn't pay the identical sticker price as
 * one asking their first. Deliberately a pure function of (volume) so it's
 * trivially testable and has no hidden state, mirroring surgeMultiplier().
 *
 * Thresholds are cumulative lifetime question counts; the multiplier is the
 * discount applied to the surge-adjusted price. A fresh/low-volume account
 * (volume below the first threshold) gets exactly 1 — zero discount is the
 * explicit default, not an accidental one. Discounts are prospective only:
 * the multiplier is computed from the volume *before* the current question is
 * counted, so crossing a threshold mid-stream never retroactively re-prices
 * questions already charged.
 */
export const VOLUME_DISCOUNT_TIERS = Object.freeze([
  Object.freeze({ minVolume: 0, multiplier: 1 }),
  Object.freeze({ minVolume: 1_000, multiplier: 0.9 }),
  Object.freeze({ minVolume: 10_000, multiplier: 0.8 }),
  Object.freeze({ minVolume: 100_000, multiplier: 0.7 }),
]);

// The floor of the discount schedule — the best multiplier any volume earns.
// Exported so callers reserving funds ahead of the real price (server.js's
// apiKeyAccountId branch, before askMetered() computes the discounted price)
// can compute a safe ceiling, the same way MAX_SURGE_MULTIPLIER caps the
// worst-case surge reservation.
export const MIN_VOLUME_DISCOUNT_MULTIPLIER = VOLUME_DISCOUNT_TIERS[VOLUME_DISCOUNT_TIERS.length - 1].multiplier;

export function volumeDiscountMultiplier(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return 1;
  let multiplier = 1;
  for (const tier of VOLUME_DISCOUNT_TIERS) {
    if (v >= tier.minVolume) multiplier = tier.multiplier;
  }
  return multiplier;
}

/** Snapshots a tier's live, surge-adjusted price. Callers must persist the
 * returned priceStroops (not just the tier key) alongside the question, so
 * later payment verification checks against the price actually quoted. */
export function priceForTier(tierKey, onlineWorkers) {
  const tier = resolveTier(tierKey);
  const multiplier = surgeMultiplier(tier, onlineWorkers);
  const priceStroops = BigInt(Math.round(Number(tier.priceStroops) * multiplier));
  return { ...tier, priceStroops, surgeMultiplier: multiplier };
}

/**
 * Snapshots a tier's live, surge-adjusted price with a customer-specific
 * volume discount applied (issue #107). The discount multiplies the
 * surge-adjusted price, so a high-volume account's reservation/settlement
 * reflects the discounted price rather than the sticker price. A fresh or
 * low-volume account (volume below the first threshold) gets the exact same
 * price as priceForTier() — zero discount is the explicit default.
 */
export function priceForTierWithVolumeDiscount(tierKey, onlineWorkers, volume) {
  const priced = priceForTier(tierKey, onlineWorkers);
  const discountMultiplier = volumeDiscountMultiplier(volume);
  const priceStroops = BigInt(Math.round(Number(priced.priceStroops) * discountMultiplier));
  return { ...priced, priceStroops, discountMultiplier };
}

/**
 * Shadow-mode AI baseline (issue #13). The `instant` tier already produces an
 * LLM draft with no human quorum; for questions dispatched on a real quorum
 * tier (standard/express/priority) we additionally generate that same instant
 * draft *in shadow* — off the settlement path — and later compare it against
 * the human-reconciled consensus. This turns "we think the LLM draft is
 * usually right" into a published, verifiable agreement rate, and is the
 * measurement prerequisite for any future AI-assisted routing.
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

// Normalizes an answer for co

/* … truncated 1885 chars — edit only what you need near the top … */

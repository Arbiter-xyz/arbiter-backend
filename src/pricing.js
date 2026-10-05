'use strict';

/**
 * Pricing helpers.
 *
 * `surgeMultiplier()` is a pure function of an aggregate input (current load)
 * and is intentionally easy to unit-test in isolation.
 */

// Base prices in stroops (1 USDC = 10_000_000 stroops, 7 decimals — matches
// the fiat onramp's documented conversion in billing.js). quorumSize is the
// number of worker answers required to settle; the instant tier has none —
// it's a single LLM draft, no human quorum at all.
//
// Built on a null-prototype object (not just Object.freeze on a plain
// literal), so a "__proto__" tier key can never resolve to Object.prototype
// itself via a plain bracket lookup — PRICING_TIERS['__proto__'] is
// genuinely undefined, not truthy, so even a naive `|| PRICING_TIERS[default]`
// caller is safe, not just resolveTier()'s explicit hasOwnProperty check.
export const PRICING_TIERS = Object.freeze(
  Object.assign(Object.create(null), {
    instant: Object.freeze({ key: 'instant', quorumSize: 0, priceStroops: 500_000n }),
    standard: Object.freeze({ key: 'standard', quorumSize: 3, priceStroops: 2_500_000n }),
    express: Object.freeze({ key: 'express', quorumSize: 2, priceStroops: 4_000_000n }),
    priority: Object.freeze({ key: 'priority', quorumSize: 5, priceStroops: 6_000_000n }),
  }),
);

export const DEFAULT_TIER_KEY = 'standard';

/**
 * Resolve a caller-supplied tier key to its tier object, falling back to the
 * default tier for any unknown key. Uses hasOwnProperty explicitly (not a
 * plain bracket lookup) so a key of "__proto__" can't resolve
 * Object.prototype itself — a bracket lookup finds it on the prototype
 * chain, where it's truthy, so a `||` fallback never triggers and
 * priceForTier() would otherwise crash trying to BigInt() a NaN instead of
 * cleanly quoting the standard price.
 */
export function resolveTier(tierKey) {
  if (Object.prototype.hasOwnProperty.call(PRICING_TIERS, tierKey)) {
    return PRICING_TIERS[tierKey];
  }
  return PRICING_TIERS[DEFAULT_TIER_KEY];
}

/** Stroops (BigInt or numeric string) to a USDC decimal string for display. */
export function stroopsToUsdc(stroops) {
  const n = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
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


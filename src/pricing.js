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

/**
 * Priority queue-jump surcharge (issue #81). A `priority`-tier question pays
 * this multiplier on top of its surge-adjusted price in exchange for being
 * ordered ahead of standard-tier questions in dispatch's per-worker queue.
 *
 * Deliberately a pure function of the tier key so it can be snapshotted at
 * quote time (see priceForTier) — the surcharge is baked into the quoted
 * priceStroops, so a payer can't observe live queue state and then decide to
 * pay for a jump after the fact. Non-priority tiers get exactly 1 (no
 * surcharge), so standard/express/instant pricing is unchanged.
 */
export const PRIORITY_QUEUE_JUMP_MULTIPLIER = 1.25;

export function priorityQueueJumpMultiplier(tierKey) {
  return resolveTier(tierKey).key === 'priority' ? PRIORITY_QUEUE_JUMP_MULTIPLIER : 1;
}

/** Snapshots a tier's live, surge-adjusted price. Callers must persist the
 * returned priceStroops (not just the tier key) alongside the question, so
 * later payment verification checks against the price actually quoted. */
export function priceForTier(tierKey, onlineWorkers) {
  const tier = resolveTier(tierKey);
  const multiplier = surgeMultiplier(tier, onlineWorkers);
  const jumpMultiplier = priorityQueueJumpMultiplier(tier.key);
  const priceStroops = BigInt(Math.round(Number(tier.priceStroops) * multiplier * jumpMultiplier));
  return { ...tier, priceStroops, surgeMultiplier: multiplier, priorityQueueJumpMultiplier: jumpMultiplier };
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
 * A/B pricing experiments per category (issue #119).
 *
 * `PRICING_TIERS` above is frozen and snapshotted once at quote time so a
 * payer's price can't move between quote and payment. Experiments must
 * preserve that invariant: the assigned variant is chosen deterministically
 * from (payerAddress, category) at quote time, and the resulting price is
 * persisted alongside `priceStroops` so verification checks the exact quoted
 * variant price rather than recomputing it.
 *
 * Unlike `PRICING_TIERS`, the experiment config is intentionally mutable —
 * operators can add/retire experiments without a code change. Each experiment
 * maps a category to a list of variants, each carrying a `priceMultiplier`
 * applied to the tier's base price. The multiplier is clamped so the resulting
 * price can never exceed `MAX_SURGE_MULTIPLIER`'s ceiling that billing.js's
 * `reserveCredit()` reserves worst-case against — an experiment price above
 * that ceiling would silently break the prepaid-balance reservation math.
 */
export const PRICING_EXPERIMENTS = Object.create(null);

/**
 * Pure, deterministic variant assignment. Hashes `payerAddress` + `category`
 * into a stable bucket and looks it up against the experiment config. Returns
 * `null` when no experiment is configured for the category (callers then fall
 * back to the unmodified tier price). No store or chain access, mirroring
 * `surgeMultiplier()`/`computeSmoothedCount()`'s testability pattern.
 */
export function assignPricingVariant(payerAddress, category) {
  const experiment = PRICING_EXPERIMENTS[category];
  if (!experiment || !Array.isArray(experiment.variants) || experiment.variants.length === 0) {
    return null;
  }
  const seed = `${payerAddress || ''}:${category}`;
  // FNV-1a 32-bit hash — stable across runs, no crypto dependency.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const variant = experiment.variants[hash % experiment.variants.length];
  return { experiment: experiment.key || category, category, variant: variant.key, priceMultiplier: variant.priceMultiplier };
}

/**
 * Snapshots a tier's price with an A/B experiment variant applied (issue
 * #119). The variant multiplier is clamped so the final price never exceeds
 * `MAX_SURGE_MULTIPLIER` times the tier's base price — the same ceiling
 * `reserveCredit()` reserves against. When no experiment is configured for
 * the category, the price is identical to `priceForTier()`.
 */
export function priceForTierWithExperiment(tierKey, onlineWorkers, payerAddress, category) {
  const priced = priceForTier(tierKey, onlineWorkers);
  const assignment = assignPricingVariant(payerAddress, category);
  if (!assignment) {
    return { ...priced, pricingVariant: null };
  }
  const tier = resolveTier(tierKey);
  const ceiling = Number(tier.priceStroops) * MAX_SURGE_MULTIPLIER;
  const rawMultiplier = Number(assignment.priceMultiplier);
  const variantMultiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1;
  const candidate = Number(priced.priceStroops) * variantMultiplier;
  const priceStroops = BigInt(Math.round(Math.min(candidate, ceiling)));
  return { ...priced, priceStroops, pricingVariant: assignment.variant, pricingExperiment: assignment.experiment };
}

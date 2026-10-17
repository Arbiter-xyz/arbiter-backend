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
    instant: Object.freeze({
      key: 'instant',
      label: 'Instant — LLM draft, no human quorum (see standard/express/priority for a staked guarantee)',
      instant: true,
      quorumSize: 0,
      timeoutMs: 0,
      priceStroops: 500_000n,
    }),
    standard: Object.freeze({
      key: 'standard',
      label: 'Standard',
      instant: false,
      quorumSize: 3,
      timeoutMs: 45_000,
      preferEstablished: false,
      priceStroops: 2_500_000n,
    }),
    express: Object.freeze({
      key: 'express',
      label: 'Express — smaller quorum, answered fast',
      instant: false,
      quorumSize: 2,
      timeoutMs: 12_000,
      preferEstablished: false,
      priceStroops: 4_000_000n,
    }),
    priority: Object.freeze({
      key: 'priority',
      label: 'Priority — larger quorum, routed to the leaderboard first',
      instant: false,
      quorumSize: 5,
      timeoutMs: 30_000,
      preferEstablished: true,
      priceStroops: 6_000_000n,
    }),
    auto: Object.freeze({
      key: 'auto',
      label: 'Auto — starts with one worker, recruits more only if unsure (charged at the maximum, unused portion refunded on API-key/prepaid billing)',
      instant: false,
      priceStroops: 6_000_000n,
      quorumSize: 5,
      timeoutMs: 45_000,
      escalation: Object.freeze({
        initialQuorum: 1,
        maxQuorum: 5,
        confidenceThreshold: 0.8,
        stepTimeoutMs: 10_000,
      }),
    }),
  }),
);

export const DEFAULT_TIER_KEY = 'standard';

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
  const frac = (n % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

export function listTiersForClient() {
  return Object.values(PRICING_TIERS).map((t) => ({
    key: t.key,
    label: t.label,
    amount: stroopsToUsdc(t.priceStroops),
    amountStroops: t.priceStroops.toString(),
    quorumSize: t.quorumSize,
    timeoutMs: t.timeoutMs,
    ...(t.escalation
      ? { escalating: true, initialQuorum: t.escalation.initialQuorum, maxQuorum: t.escalation.maxQuorum }
      : {}),
  }));
}

const COMFORTABLE_SUPPLY_MULTIPLE = 3;
export const MAX_SURGE_MULTIPLIER = 2;
const MIN_SURGE_MULTIPLIER = 1;

export function surgeMultiplier(tier, onlineWorkers) {
  const comfortable = tier.quorumSize * COMFORTABLE_SUPPLY_MULTIPLE;
  if (comfortable <= 0 || onlineWorkers >= comfortable) return MIN_SURGE_MULTIPLIER;
  const scarcity = 1 - onlineWorkers / comfortable;
  const raw = MIN_SURGE_MULTIPLIER + scarcity * (MAX_SURGE_MULTIPLIER - MIN_SURGE_MULTIPLIER);
  return Math.round(raw * 100) / 100;
}

export const VOLUME_DISCOUNT_TIERS = Object.freeze([
  Object.freeze({ minVolume: 0, multiplier: 1 }),
  Object.freeze({ minVolume: 1_000, multiplier: 0.9 }),
  Object.freeze({ minVolume: 10_000, multiplier: 0.8 }),
  Object.freeze({ minVolume: 100_000, multiplier: 0.7 }),
]);

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

export function priceForTier(tierKey, onlineWorkers) {
  const tier = resolveTier(tierKey);
  const multiplier = surgeMultiplier(tier, onlineWorkers);
  const priceStroops = BigInt(Math.round(Number(tier.priceStroops) * multiplier));
  return { ...tier, priceStroops, surgeMultiplier: multiplier };
}

export function priceForTierWithVolumeDiscount(tierKey, onlineWorkers, volume) {
  const priced = priceForTier(tierKey, onlineWorkers);
  const discountMultiplier = volumeDiscountMultiplier(volume);
  const priceStroops = BigInt(Math.round(Number(priced.priceStroops) * discountMultiplier));
  return { ...priced, priceStroops, discountMultiplier };
}

export function effectiveEscalatedPriceStroops(tier, recruitedWorkers) {
  if (!tier || !tier.escalation) return tier?.priceStroops ?? 0n;
  const { maxQuorum } = tier.escalation;
  const n = Math.min(Math.max(Math.trunc(Number(recruitedWorkers)) || 0, 1), maxQuorum);
  return (tier.priceStroops * BigInt(n)) / BigInt(maxQuorum);
}

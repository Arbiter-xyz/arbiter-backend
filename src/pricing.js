/**
 * Pricing tiers replace v1's single flat $0.25 price. The contract itself
 * was always tier-agnostic (submit() takes an arbitrary i128 amount) — this
 * was purely a backend policy gap. Each tier trades price for quorum size
 * and how long the async job waits for workers before falling back to
 * whatever answered in time.
 */
export const PRICING_TIERS = Object.freeze({
  standard: Object.freeze({
    key: 'standard',
    label: 'Standard',
    priceStroops: 2_500_000n,
    quorumSize: 3,
    timeoutMs: 45_000,
  }),
  express: Object.freeze({
    key: 'express',
    label: 'Express — smaller quorum, answered fast',
    priceStroops: 4_000_000n,
    quorumSize: 2,
    timeoutMs: 12_000,
  }),
  priority: Object.freeze({
    key: 'priority',
    label: 'Priority — larger quorum, higher confidence',
    priceStroops: 6_000_000n,
    quorumSize: 5,
    timeoutMs: 30_000,
  }),
});

export const DEFAULT_TIER_KEY = 'standard';

export function resolveTier(tierKey) {
  return PRICING_TIERS[tierKey] || PRICING_TIERS[DEFAULT_TIER_KEY];
}

export function stroopsToUsdc(stroops) {
  const s = BigInt(stroops);
  const whole = s / 10_000_000n;
  const frac = (s % 10_000_000n).toString().padStart(7, '0');
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
  }));
}

/**
 * Live surge pricing — replaces a flat per-tier price with one that reacts
 * to real-time worker supply, the same way Uber/Tesla-Supercharger pricing
 * treats price as a control signal rather than a fixed sticker. "Comfortable"
 * supply (COMFORTABLE_SUPPLY_MULTIPLE × the tier's quorum size online) buys
 * the base price; price rises smoothly as supply gets scarce, capped at
 * MAX_SURGE_MULTIPLIER, and never drops below the base (a discount would
 * make worker payouts unpredictable for the same tier). Deliberately a pure
 * function of (tier, onlineWorkers) so it's trivially testable and has no
 * hidden state of its own — the caller is responsible for snapshotting the
 * result at quote time, since supply can change before payment lands.
 */
const COMFORTABLE_SUPPLY_MULTIPLE = 3;
const MAX_SURGE_MULTIPLIER = 2;
const MIN_SURGE_MULTIPLIER = 1;

export function surgeMultiplier(tier, onlineWorkers) {
  const comfortable = tier.quorumSize * COMFORTABLE_SUPPLY_MULTIPLE;
  if (comfortable <= 0 || onlineWorkers >= comfortable) return MIN_SURGE_MULTIPLIER;
  const scarcity = 1 - onlineWorkers / comfortable; // 0 (comfortable supply) .. 1 (nobody online)
  const raw = MIN_SURGE_MULTIPLIER + scarcity * (MAX_SURGE_MULTIPLIER - MIN_SURGE_MULTIPLIER);
  return Math.round(raw * 100) / 100;
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

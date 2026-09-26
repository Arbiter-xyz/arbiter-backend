/**
 * Pricing tiers replace v1's single flat $0.25 price. The contract itself
 * was always tier-agnostic (submit() takes an arbitrary i128 amount) — this
 * was purely a backend policy gap. Each tier trades price for quorum size
 * and how long the async job waits for workers before falling back to
 * whatever answered in time.
 */
export const PRICING_TIERS = Object.freeze({
  // No human quorum at all — an immediate LLM-generated draft, settled the
  // moment it comes back. Cheaper and near-instant on purpose: it's a
  // different product promise ("a fast draft") than every other tier
  // ("a staked human quorum verified it"), not a discount on the same one.
  // quorumSize 0 / timeoutMs 0 are sentinels oracle.js checks for to skip
  // dispatch entirely, not real dispatch parameters.
  instant: Object.freeze({
    key: 'instant',
    label: 'Instant — LLM draft, no human quorum (see standard/express/priority for a staked guarantee)',
    priceStroops: 500_000n,
    quorumSize: 0,
    timeoutMs: 0,
    instant: true,
  }),
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
    label: 'Priority — larger quorum, routed to the leaderboard first',
    priceStroops: 6_000_000n,
    quorumSize: 5,
    timeoutMs: 30_000,
    // Ties this tier to the public leaderboard (see leaderboard.js) instead
    // of "higher confidence" being just a bigger-quorum claim — Priority
    // actually means "this went to established, track-recorded verifiers
    // first." See dispatch.js's selectTargets for the fail-open behavior.
    preferEstablished: true,
  }),
  // Self-driving quorum: asks one worker first and only recruits more when
  // that answer isn't confident enough (see dispatch.js's decideEscalation).
  // The final quorum size isn't known at quote time, so this is quoted and
  // charged at a CEILING — the price of the fully-escalated quorum
  // (escalation.maxQuorum workers, same per-worker rate as `priority`).
  // quorumSize is that ceiling on purpose: surgeMultiplier() scales off it,
  // so worker-supply scarcity is judged against the worst-case recruit.
  // What happens to the difference once the real size is known:
  //   - metered / API-key flow: the unused portion is refunded to the
  //     customer's credit (billing.js settleReservation, via
  //     effectiveEscalatedPriceStroops below).
  //   - classic on-chain submit() flow: the escrowed amount is fixed at
  //     payment time and the contract can't shrink it, so the platform keeps
  //     the delta — same as today's surge ceiling. The job record shows both
  //     numbers (amountStroops charged vs effectiveAmountStroops used).
  auto: Object.freeze({
    key: 'auto',
    label: 'Auto — starts with one worker, recruits more only if unsure (charged at the maximum, unused portion refunded on API-key/prepaid billing)',
    priceStroops: 6_000_000n,
    quorumSize: 5,
    timeoutMs: 45_000,
    escalation: Object.freeze({
      initialQuorum: 1,
      maxQuorum: 5,
      // Minimum confidence in a lone worker's answer to settle on it alone.
      confidenceThreshold: 0.8,
      // How long to wait on the current recruits before recruiting more.
      stepTimeoutMs: 10_000,
    }),
  }),
});

export const DEFAULT_TIER_KEY = 'standard';

// hasOwnProperty guard, not a plain bracket lookup: a plain
// PRICING_TIERS[tierKey] on a caller-supplied string resolves inherited
// Object.prototype members too — tierKey: "__proto__" returns
// Object.prototype itself (truthy, so the `||` default never kicks in),
// and priceForTier() then crashes trying to BigInt() a NaN instead of
// cleanly falling back to the standard tier.
export function resolveTier(tierKey) {
  return Object.prototype.hasOwnProperty.call(PRICING_TIERS, tierKey) ? PRICING_TIERS[tierKey] : PRICING_TIERS[DEFAULT_TIER_KEY];
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
    ...(t.escalation
      ? { escalating: true, initialQuorum: t.escalation.initialQuorum, maxQuorum: t.escalation.maxQuorum }
      : {}),
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
 * This is purely observability: it must never affect settlement, timing, or
 * cost of the real dispatch. The helpers below are deliberately pure and
 * side-effect-free so callers can run them alongside the existing quorum
 * without touching the dispatch path.
 */

// Tiers that carry a real human quorum and therefore qualify for a shadow
// draft. `instant` is excluded — it *is* the draft, not a shadow of one.
export function shouldShadowDraft(tierKey) {
  const tier = resolveTier(tierKey);
  return !tier.instant && tier.quorumSize > 0;
}

// Normalizes an answer for co

/* … truncated 1885 chars — edit only what you need near the top … */

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

// Normalizes an answer for comparison so trivial formatting differences
// (case, surrounding whitespace, collapsed internal whitespace) don't count
// as disagreement. Kept intentionally conservative — anything beyond this
// would be guessing at semantic equivalence, which is out of scope here.
export function normalizeDraftAnswer(answer) {
  if (answer === null || answer === undefined) return '';
  return String(answer).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Compares a shadow instant-tier draft against the human-reconciled consensus
 * outcome for the same question. Returns a record keyed the same way stats.js
 * tracks its `resolved`/`refunded` counters, so the shadow counters can be
 * aggregated with the same machinery. `matched` is only meaningful when the
 * question actually settled to a consensus answer; a refunded/no-consensus
 * question is recorded as `refunded` and excluded from the agreement rate.
 */
export function recordShadowAgreement({ draftAnswer, consensusAnswer, outcome }) {
  if (outcome !== 'resolved') {
    return { outcome: 'refunded', matched: false, counted: false };
  }
  const matched = normalizeDraftAnswer(draftAnswer) === normalizeDraftAnswer(consensusAnswer);
  return { outcome: 'resolved', matched, counted: true };
}

/**
 * Aggregates shadow-agreement counters into the published rate. Mirrors the
 * shape stats.js exposes for resolved/refunded so it can be surfaced the same
 * way (e.g. via /stats or an admin endpoint). `agreementRate` is null until
 * there's at least one counted (resolved) comparison, so callers don't publish
 * a misleading 0% before any data exists.
 */
export function shadowAgreementRate({ matched = 0, mismatched = 0, refunded = 0 } = {}) {
  const counted = matched + mismatched;
  return {
    matched,
    mismatched,
    refunded,
    counted,
    agreementRate: counted > 0 ? matched / counted : null,
  };
}

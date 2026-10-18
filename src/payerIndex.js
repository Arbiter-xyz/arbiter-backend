import { store } from './store.js';
import { stroopsToUsdc } from './pricing.js';

/**
 * Payers are otherwise anonymous to this API — there's no signup, no API
 * key, nothing linking a POST /oracle call to an identity until the payer
 * actually signs a submit() on-chain. This index is built AFTER that
 * point (see oracle.js::verifyPayment), keyed by the payer's own address,
 * so a dashboard can show "questions I paid for" the same way the worker
 * console shows "questions I answered" — by having the payer connect
 * their wallet, not by any account system.
 */
const PREFIX = 'payer-questions:';
const MAX_TRACKED_PER_PAYER = 200; // bound growth; keep the most recent

// Mirrors dispatch.js's WORKER_INDEX_KEY / jobs.js's JOB_INDEX_KEY: a
// durable, bounded list of every payer address ever seen, so an admin
// "Payers" list can be enumerated without a store-wide scan.
const PAYER_INDEX_KEY = 'known-payer-addresses';
const MAX_TRACKED_PAYERS = 5_000;

// CCPA (#127) reuses the GDPR (#126) data-access/erasure plumbing rather
// than re-deriving the per-address store fan-out. This module owns the
// payerIndex.js slice of that fan-out; the CCPA wrapper composes it with
// the other stores' slices (dispatch.js `rep:` records, push.js
// subscriptions, anchorRecords.js cache) via the shared request handler.
//
// "Personal information" under this system's actual data model is narrow:
// a Stellar public key (the payer address) plus self-reported anchor KYC
// status. There are no names, emails, or other direct PII stored here, so
// the CCPA access/erasure surface is exactly the same address-keyed data
// the GDPR endpoints already expose — no parallel implementation.
const CCPA_REQUEST_PREFIX = 'ccpa-request:';
const MAX_TRACKED_CCPA_REQUESTS = 5_000;

// CCPA statutory response window: 45 days from receipt, extendable once by
// another 45 days. We record the receipt timestamp so a request can be
// tracked against that deadline without re-deriving it from logs.
const CCPA_RESPONSE_WINDOW_DAYS = 45;
const CCPA_RESPONSE_WINDOW_MS = CCPA_RESPONSE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export async function getKnownPayerAddresses() {
  return (await store.get(PAYER_INDEX_KEY)) || [];
}

export async function recordPayerQuestion(payerAddress, questionId) {
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const isNew = existing.length === 0;
  const next = [questionId, ...existing.filter((id) => id !== questionId)].slice(0, MAX_TRACKED_PER_PAYER);
  await store.set(key, next); // no TTL — durable, same choice as reputation

  if (isNew) {
    const known = await getKnownPayerAddresses();
    if (!known.includes(payerAddress)) {
      await store.set(PAYER_INDEX_KEY, [payerAddress, ...known].slice(0, MAX_TRACKED_PAYERS));
    }
  }
}

export async function getPayerQuestionIds(payerAddress) {
  return (await store.get(PREFIX + payerAddress)) || [];
}

/**
 * GDPR erasure (#126): delete this payer's off-chain records — the
 * `payer-questions:` list and, if present, the address's entry in the
 * known-payer index. On-chain state (resolved questions, stake, owed
 * balances) is structurally permanent and is NOT touched here; callers
 * must surface that distinction in the response body, not just in code.
 * Returns a summary of exactly what was removed so the endpoint can report
 * it honestly.
 */
export async function erasePayerRecords(payerAddress) {
  if (!payerAddress) return { deleted: false, questionIds: 0, removedFromIndex: false };

  const ids = await getPayerQuestionIds(payerAddress);
  await store.delete(PREFIX + payerAddress);

  const known = await getKnownPayerAddresses();
  const removedFromIndex = known.includes(payerAddress);
  if (removedFromIndex) {
    await store.set(PAYER_INDEX_KEY, known.filter((a) => a !== payerAddress));
  }

  return { deleted: true, questionIds: ids.length, removedFromIndex };
}

/**
 * Pure aggregation so it's testable without needing real chain-derived
 * job data — `jobs[i]` may be null/undefined if a job record has expired
 * (see jobs.js's TTL), which is filtered out rather than surfaced as a
 * broken row.
 */
export function summarizePayerQuestions(ids, jobs) {
  const questions = ids.map((questionId, i) => ({ questionId, ...jobs[i] })).filter((q) => q.status);

  const totalSpendStroops = questions.reduce((sum, q) => sum + BigInt(q.amountStroops || 0), 0n);
  const resolved = questions.filter((q) => q.outcome === 'resolved').length;
  const settled = questions.filter((q) => q.status === 'settled').length;

  return {
    questions,
    totalTracked: ids.length,
    totalSpendStroops,
    resolved,
    settled,
    successRate: settled > 0 ? resolved / settled : null,
  };
}

/**
 * Loyalty tiers, keyed off the same aggregate summarizePayerQuestions()
 * already produces. Structurally mirrors pricing.js's surgeMultiplier():
 * a pure function of an aggregate input, so it's unit-testable in
 * isolation without any store or chain access.
 *
 * Thresholds are lifetime spend in stroops (7-decimal USDC, matching
 * amountStroops everywhere else). `bonusStroops` is the one-time credit
 * granted when a payer first reaches that tier — see
 * evaluateLoyaltyTier() for the idempotency that keeps it one-time.
 */
export const LOYALTY_TIERS = [
  { name: 'bronze', minSpendStroops: 10_000_000n, bonusStroops: 500_000n },
  { name: 'silver', minSpendStroops: 100_000_000n, bonusStroops: 5_000_000n },
  { name: 'gold', minSpendStroops: 1_000_000_000n, bonusStroops: 50_000_000n },
];

/**
 * Pure tier evaluation: takes a payer's spend summary (the object returned
 * by summarizePayerQuestions()) and returns the highest tier whose
 * threshold the payer's lifetime spend has reached, plus the bonus credit
 * that tier carries. Returns null when no threshold is met.
 *
 * Deliberately reads only `totalSpendStroops` — the durable aggregate — so
 * callers aren't tempted to re-scan the bounded tracked list for lifetime
 * totals (see MAX_TRACKED_PER_PAYER).
 */
export function evaluateLoyaltyTier(summary) {
  const spend = BigInt(summary?.totalSpendStroops || 0);
  let matched = null;
  for (const tier of LOYALTY_TIERS) {
    if (spend >= tier.minSpendStroops) matched = tier;
  }
  if (!matched) return null;
  return {
    tier: matched.name,
    minSpendStroops: matched.minSpendStroops.toString(),
    bonusStroops: matched.bonusStroops.toString(),
    bonus: stroopsToUsdc(matched.bonusStroops),
  };
}

/**
 * Spend dashboards (arbiter-app) chart spend by category and over time.
 * Every input is already on the job record, but bucketing it here saves each
 * consumer from re-deriving the same aggregation client-side.
 *
 * `questions` is summarizePayerQuestions()'s filtered list, so expired jobs
 * are already gone. Questions without a category (asked without one, or
 * created before category was persisted) share a single `null` bucket. Days
 * are UTC calendar days of the question's createdAt, since that's when the
 * spend happened. Stroop amounts are decimal strings, because BigInt isn't
 * JSON-serializable, alongside the same 7-decimal USDC string used
 * everywhere else. Refunded questions still count toward spend: this
 * mirrors totalSpendStroops, which is the amount paid in, not the net.
 */
export function bucketPayerSpend(questions) {
  const byCategory = new Map();
  const byDay = new Map();

  const add = (map, key, extra, amount, outcome) => {
    const bucket = map.get(key) || { ...extra, questions: 0, resolved: 0, spendStroops: 0n };
    bucket.questions += 1;
    if (outcome === 'resolved') bucket.resolved += 1;
    bucket.spendStroops += amount;
    map.set(key, bucket);
  };

  for (const q of questions) {
    const amount = BigInt(q.amountStroops || 0);
    const category = q.category ? String(q.category).trim().toLowerCase() : null;
    add(byCategory, category, { category }, amount, q.outcome);
    if (Number.isFinite(q.createdAt)) {
      const day = new Date(q.createdAt).toISOString().slice(0, 10);
      add(byDay, day, { day }, amount, q.outcome);
    }
  }

  const serialize = (b) => ({ ...b, spendStroops: b.spendStroops.toString(), spend: stroopsToUsdc(b.spendStroops) });
  return {
    // Biggest spend first; uncategorized sorts last among equals.
    spendByCategory: [...byCategory.values()]
      .sort((a, b) => (b.spendStroops > a.spendStroops ? 1 : b.spendStroops < a.spendStroops ? -1 : (a.category === null) - (b.category === null)))
      .map(serialize),
    // Chronological, ready to plot.
    spendByDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(serialize),
  };
}

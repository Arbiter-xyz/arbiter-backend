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

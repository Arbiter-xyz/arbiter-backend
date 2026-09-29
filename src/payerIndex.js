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
 * CCPA (#127) request handling. This is a thin wrapper over the same
 * address-keyed data-access/erasure plumbing #126 exposes — it does not
 * duplicate the store fan-out. It only adds CCPA-specific bookkeeping:
 * categorizing the request and recording a receipt timestamp suitable for
 * tracking against CCPA's statutory response window.
 *
 * CCPA and GDPR are treated as the same underlying request type; there is
 * no jurisdiction detection or auto-routing (explicitly out of scope).
 */
export async function recordCcpaRequest({ requestId, payerAddress, type, receivedAt = Date.now() }) {
  const record = {
    requestId,
    payerAddress,
    // 'access' | 'deletion' — the two CCPA individual rights this backend
    // can actually honor against its data model.
    type,
    receivedAt,
    // Deadline for the initial 45-day response window; a single 45-day
    // extension is permitted but tracked by the caller, not assumed here.
    responseDueAt: receivedAt + CCPA_RESPONSE_WINDOW_MS,
  };
  await store.set(CCPA_REQUEST_PREFIX + requestId, record);

  const known = (await store.get(CCPA_REQUEST_PREFIX + 'index')) || [];
  if (!known.includes(requestId)) {
    await store.set(CCPA_REQUEST_PREFIX + 'index', [requestId, ...known].slice(0, MAX_TRACKED_CCPA_REQUESTS));
  }
  return record;
}

export async function getCcpaRequest(requestId) {
  return (await store.get(CCPA_REQUEST_PREFIX + requestId)) || null;
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

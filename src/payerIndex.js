import { store } from './store.js';

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

export async function recordPayerQuestion(payerAddress, questionId) {
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const next = [questionId, ...existing.filter((id) => id !== questionId)].slice(0, MAX_TRACKED_PER_PAYER);
  await store.set(key, next); // no TTL — durable, same choice as reputation
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

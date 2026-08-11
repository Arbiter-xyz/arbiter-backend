import { store } from './store.js';
import { config } from './config.js';

const PREFIX = 'job:';

/**
 * Async job record for a paid question. Replaces v1's design of holding the
 * client's HTTP request open for up to QUORUM_TIMEOUT_MS while workers
 * answer — that's fragile against proxies, mobile networks, and
 * serverless/edge request timeouts. Instead POST /oracle's second step
 * returns 202 immediately once payment is confirmed, and the caller polls
 * GET /oracle/:jobId (or listens on its SSE stream) for the result.
 *
 * States: awaiting_workers -> reconciling -> settled
 * `settled` always carries an `outcome` of 'resolved' or 'refunded' — same
 * fail-closed guarantee as before, just observed asynchronously.
 */

/**
 * Atomically claims a job id for fulfillment, returning true only for the
 * FIRST caller. Two concurrent requests for the same questionId (a genuine
 * retry racing the original, not just a sequential one) could otherwise
 * both observe "no job yet" via getJob() and both proceed to dispatch —
 * store.incr() is the same atomic primitive the rate limiter relies on
 * (see store.js's MemoryStore.incr for why it has to be atomic), reused
 * here instead of inventing a second locking mechanism.
 */
export async function claimJob(jobId) {
  const claimCount = await store.incr(`${PREFIX}claim:${jobId}`, config.jobResultTtlMs);
  return claimCount === 1;
}

export async function createJob(jobId, initial) {
  const record = {
    status: 'awaiting_workers',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...initial,
  };
  await store.set(PREFIX + jobId, record, config.jobResultTtlMs);
  return record;
}

export async function updateJob(jobId, patch) {
  const key = PREFIX + jobId;
  const current = (await store.get(key)) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await store.set(key, next, config.jobResultTtlMs);
  return next;
}

export async function getJob(jobId) {
  return store.get(PREFIX + jobId);
}

import { store } from './store.js';
import { config } from './config.js';

const PREFIX = 'job:';

// A single durable list of every jobId ever created, in most-recent-first
// order — jobs themselves are keyed by jobId (job:{id}), fine for a single
// lookup but not enumerable on their own. Same index pattern as dispatch.js's
// WORKER_INDEX_KEY / payerIndex.js's payer index: bounded and durable, since
// unbounded growth (not capacity) is the real failure mode at this scale.
// This is what makes an admin "Transactions" list possible without a Redis
// KEYS/SCAN (unsafe in production, and unsupported by the in-memory store).
const JOB_INDEX_KEY = 'known-job-ids';
const MAX_TRACKED_JOBS = 5_000;

// Terminal states never need reconciliation again. Everything else is
// "in-flight" and must be checked against on-chain truth on startup.
const TERMINAL_STATUSES = new Set(['settled']);

// Synthetic monitoring (issue #111): a scheduled job runs the real paid
// /oracle flow end to end against a live deployment on an interval, reusing
// demo-agent/ask.js's existing submit()/dispatch/reconcile/resolve() path
// rather than reimplementing it. Synthetic jobs are tagged here so a failed
// run (timeout, refund, error) is distinguishable in logs from a successful
// one and from real customer activity, and so /stats can exclude them the
// same way sandbox settlements already are.
const SYNTHETIC_INDEX_KEY = 'synthetic-job-ids';
const MAX_TRACKED_SYNTHETIC_JOBS = 1_000;

async function indexJob(jobId) {
  const known = (await store.get(JOB_INDEX_KEY)) || [];
  if (known.includes(jobId)) return;
  await store.set(JOB_INDEX_KEY, [jobId, ...known].slice(0, MAX_TRACKED_JOBS));
}

export async function getKnownJobIds() {
  return (await store.get(JOB_INDEX_KEY)) || [];
}

/**
 * Marks a job as synthetic (a scheduled monitor run, not a real customer
 * question) and records it in a separate index so /stats can exclude it.
 * Called by the synthetic runner right after createJob(), before dispatch,
 * so the tag is present for the entire lifetime of the job and every log
 * line emitted for it can carry `synthetic: true`.
 */
export async function markSynthetic(jobId) {
  await updateJob(jobId, { synthetic: true });
  const known = (await store.get(SYNTHETIC_INDEX_KEY)) || [];
  if (!known.includes(jobId)) {
    await store.set(
      SYNTHETIC_INDEX_KEY,
      [jobId, ...known].slice(0, MAX_TRACKED_SYNTHETIC_JOBS),
    );
  }
}

export async function getSyntheticJobIds() {
  return (await store.get(SYNTHETIC_INDEX_KEY)) || [];
}

/**
 * True when a job record is a synthetic monitor run. Used by /stats to keep
 * synthetic settlements out of the public counters, consistent with how
 * sandbox traffic is already excluded (see stats.js).
 */
export function isSyntheticJob(job) {
  return Boolean(job && job.synthetic);
}

/**
 * Async job record for a paid question. Replaces v1's design of holding the
 * client's HTTP request open for up to QUORUM_TIMEOUT_MS while workers
 * answer — that's fragile against proxies, mobile networks, and
 * serverless/edge request timeouts. Instead POST /oracle's second step
 * returns 202 immediately once payment is confirmed, and the caller polls
 * GET /oracle/:jobId (or listens on its SSE stream) for the result.
 *
 * States: [holding ->] awaiting_workers -> reconciling -> settled
 * `holding` is the undo window (see undoWindow.js) — paid, not yet
 * dispatched, cancellable until `cancellableUntil`; a cancelled job goes
 * holding -> cancelling -> settled instead.
 * `settled` always carries an `outcome` of 'resolved' or 'refunded' — same
 * fail-closed guarantee as before, just observed asynchronously.
 *
 * Crash-safety: the on-chain question status is the single source of truth.
 * A job may be persisted as non-terminal even after resolve()/refund()
 * succeeded on-chain (the process died before the record was updated), so
 * settlement is only ever driven by reading on-chain state — never by
 * replaying a persisted "intent". See reconcileJobs() below.
 */

/**
 * Atomically claims a job id for fulfillment, returning true only for the
 * FIRST caller. Two concurrent requests for the same questionId (a genuine
 * retry racing the original, not just a sequential one) could otherwise
 * both observe "no job yet" via getJob() and both proceed to dispatch —
 * store.incr() is the same atomic primitive the rate limiter relies on
 * (see store.js's MemoryStore.incr for why it has to be atomic), reused
 * here instead of inventing a second locking mechanism.
 *
 * This is the single gate that must hold under true network-level duplicate
 * delivery: a proxy or client retry can send the exact same request twice,
 * truly simultaneously, over separate connections. Because store.incr() is
 * atomic, exactly one of those callers observes claimCount === 1 and wins;
 * every other caller (however many, however simultaneous) observes > 1 and
 * is rejected. The claim key is written with the same TTL as the job record
 * so a claim can never outlive the job it guards.
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
  await indexJob(jobId);
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

/**
 * Marks a job terminal exactly once. Returns true only for the caller that
 * actually transitioned the job out of a non-terminal state, so a settlement
 * path can use this as its idempotency guard: if it returns false, another
 * path (or a previous run) already recorded the terminal outcome and no
 * on-chain call should be made.
 */
export async function markSettled(jobId, outcome, extra = {}) {
  const key = PREFIX + jobId;
  const current = (await store.get(key)) || {};
  if (TERMINAL_STATUSES.has(current.status)) return false;
  const next = {
    ...current,
    ...extra,
    status: 'settled',
    outcome,
    settledAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.set(key, next, config.jobResultTtlMs);
  return true;
}

/**
 * Startup recovery. Walks every non-terminal job and reconciles it against
 * live on-chain question status before any settlement work resumes.
 *
 * `readOnChainStatus(questionId)` must return the authoritative on-chain
 * status for the question (e.g. 'open' | 'resolved' | 'refunded'). It is the
 * ONLY input that decides whether a settlement call is needed — a job that
 * was mid-fulfillOracleCall when the process died is indistinguishable from
 * one that never started, so both are simply re-driven from on-chain truth.
 *
 * `settle(job, onChainStatus)` performs the (idempotent) settlement for a
 * job whose on-chain status is already terminal. It must itself check
 * on-chain status before calling resolve()/refund() so a crash between the
 * on-chain call and markSettled() cannot cause a duplicate call on the next
 * restart.
 *
 * Returns a summary for logging/tests.
 */
export async function reconcileJobs({ readOnChainStatus, settle, resume } = {}) {
  const jobIds = await getKnownJobIds();
  const summary = { scanned: 0, settled: 0, resumed: 0, skipped: 0, failed: 0 };

  for (const jobId of jobIds) {
    const job = await getJob(jobId);
    if (!job) continue;
    summary.scanned += 1;

    if (TERMINAL_STATUSES.has(job.status)) {
      summary.skipped += 1;
      continue;
    }

    try {
      const onChainStatus = await readOnChainStatus(job.questionId);

      if (onChainStatus === 'resolved' || onChainStatus === 'refunded') {
        // On-chain truth says this question is already settled. Record the
        // terminal outcome locally without ever calling resolve()/refund()
        // again — this is the no-double-settle guarantee.
        const changed = await markSettled(jobId, onChainStatus, {
          recovered: true,
        });
        if (changed) summary.settled += 1;
        else summary.skipped += 1;
        continue;
      }

      // Still open on-chain: the job never reached a terminal on-chain state
      // (including the mid-fulfillOracleCall case). Hand it back to the
      // normal settlement pipeline, which re-checks on-chain status before
      // acting, so resuming is safe and idempotent.
      if (typeof resume === 'function') {
        await resume(job);
        summary.resumed += 1;
      } else if (typeof settle === 'function') {
        await settle(job, onChainStatus);
        summary.resumed += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      // A single unreconcilable job must not abort startup recovery for the
      // rest; it stays non-terminal and will be retried on the next restart.
      summary.failed += 1;
    }
  }

  return summary;
}

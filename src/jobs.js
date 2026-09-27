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

// Durable review queue, following the same bounded-index pattern as
// JOB_INDEX_KEY above. Holds the jobIds currently sitting in `pending_review`
// so an admin can enumerate them without a KEYS/SCAN. Entries are removed
// when a review is approved (or when reconciliation settles the job), so the
// list stays bounded by the number of in-flight reviews, not by history.
const REVIEW_INDEX_KEY = 'pending-review-job-ids';
const MAX_TRACKED_REVIEWS = 5_000;

// Terminal states never need reconciliation again. Everything else is
// "in-flight" and must be checked against on-chain truth on startup.
const TERMINAL_STATUSES = new Set(['settled']);

async function indexJob(jobId) {
  const known = (await store.get(JOB_INDEX_KEY)) || [];
  if (known.includes(jobId)) return;
  await store.set(JOB_INDEX_KEY, [jobId, ...known].slice(0, MAX_TRACKED_JOBS));
}

export async function getKnownJobIds() {
  return (await store.get(JOB_INDEX_KEY)) || [];
}

async function indexReview(jobId) {
  const pending = (await store.get(REVIEW_INDEX_KEY)) || [];
  if (pending.includes(jobId)) return;
  await store.set(REVIEW_INDEX_KEY, [jobId, ...pending].slice(0, MAX_TRACKED_REVIEWS));
}

async function unindexReview(jobId) {
  const pending = (await store.get(REVIEW_INDEX_KEY)) || [];
  if (!pending.includes(jobId)) return;
  await store.set(REVIEW_INDEX_KEY, pending.filter((id) => id !== jobId));
}

/**
 * Returns the jobIds currently awaiting manual review, most-recent-first.
 * Backs the admin "pending reviews" list route.
 */
export async function getPendingReviewJobIds() {
  return (await store.get(REVIEW_INDEX_KEY)) || [];
}

/**
 * Returns the full job records currently in `pending_review`. Jobs whose
 * record has expired (TTL) or already left the review state are filtered out
 * and pruned from the index so the queue self-heals.
 */
export async function getPendingReviews() {
  const jobIds = await getPendingReviewJobIds();
  const reviews = [];
  for (const jobId of jobIds) {
    const job = await getJob(jobId);
    if (job && job.status === 'pending_review') {
      reviews.push(job);
    } else {
      await unindexReview(jobId);
    }
  }
  return reviews;
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
 * A job whose reconciliation result is flagged for human review branches
 * reconciling -> pending_review instead of settling immediately; an admin
 * approval then drives it to `settled` through the same on-chain path as an
 * automatic settlement (see approveReview() below).
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
 * Moves a job into the manual review queue. Returns true only for the caller
 * that actually transitioned the job out of a non-terminal, non-review state,
 * so the settlement path can use this as its idempotency guard: if it returns
 * false, the job is already terminal or already queued and no further action
 * should be taken.
 *
 * The job keeps its `questionId` and any reconciliation metadata (e.g. the
 * confidence that triggered the review) so an admin can inspect why it was
 * flagged, and so approveReview() can settle it through the same on-chain
 * path as an automatic settlement.
 */
export async function markPendingReview(jobId, extra = {}) {
  const key = PREFIX + jobId;
  const current = (await store.get(key)) || {};
  if (TERMINAL_STATUSES.has(current.status)) return false;
  if (current.status === 'pending_review') return false;
  const next = {
    ...current,
    ...extra,
    status: 'pending_review',
    reviewRequestedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.set(key, next, config.jobResultTtlMs);
  await indexReview(jobId);
  return true;
}

/**
 * Approves a queued review and settles it through the SAME on-chain path as
 * an automatic settlement. `settle(job, outcome)` is expected to call the
 * existing resolveQuestion()/refundQuestion() stellarClient functions (the
 * ones oracle.js already uses) and then markSettled() — so a manually
 * approved outcome produces an identical job record shape to an automatic
 * one.
 *
 * Returns the settled job record, or null if the job was not in
 * `pending_review` (already settled, expired, or never queued). The review
 * index entry is removed on success so the queue stays bounded.
 */
export async function approveReview(jobId, outcome, settle) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'pending_review') return null;
  if (outcome !== 'resolved' && outcome !== 'refunded') {
    throw new Error(`invalid review outcome: ${outcome}`);
  }

  if (typeof settle === 'function') {
    await settle(job, outcome);
  } else {
    await markSettled(jobId, outcome, { reviewed: true });
  }

  await unindexReview(jobId);
  return getJob(jobId);
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
  await unindexReview(jobId);
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
 * Jobs in `pending_review` are left untouched: they are deliberately parked
 * awaiting a human decision, and the contract's permissionless
 * refund_timeout() remains the escape hatch if a reviewer never acts. They
 * are counted as `skipped` so recovery never silently settles a review.
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

    // A job parked for manual review is not auto-settled on restart — that
    // would defeat the human-in-the-loop gate. It stays queued until an
    // admin approves it (or the contract's refund_timeout() preempts it).
    if (job.status === 'pending_review') {
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

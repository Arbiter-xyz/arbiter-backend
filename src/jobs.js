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

// Escalation index (#125). A single shared mechanism for items from BOTH the
// manual review queue (#123) and disputes (#124) that have been escalated to
// a senior reviewer. Follows the same bounded durable-index pattern as
// JOB_INDEX_KEY / REVIEW_INDEX_KEY above. Entries are `{ kind, id }` pairs so
// one list can carry both review-queue jobs and disputes without two parallel
// mechanisms; `kind` is 'review' or 'dispute'. Escalation itself is gated on
// role-based admin permissions (#131) at the route layer — this store only
// records the flag state, not who is allowed to set it.
const ESCALATION_INDEX_KEY = 'escalated-item-ids';
const MAX_TRACKED_ESCALATIONS = 5_000;

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
 * Escalates an item to a senior reviewer. `kind` is 'review' (a #123 review
 * queue job) or 'dispute' (a #124 dispute), so both item types share this one
 * mechanism rather than two parallel ones. Idempotent: escalating an already
 * escalated item is a no-op. Returns true only for the caller that actually
 * set the flag, so callers can distinguish "newly escalated" from "already
 * escalated".
 *
 * Authorization (that the caller holds a senior-reviewer role) is enforced at
 * the route layer via #131's role-based admin permissions — this function
 * only records the durable flag state.
 */
export async function escalateItem(kind, id) {
  const escalated = (await store.get(ESCALATION_INDEX_KEY)) || [];
  if (escalated.some((e) => e.kind === kind && e.id === id)) return false;
  const next = [{ kind, id, escalatedAt: Date.now() }, ...escalated].slice(
    0,
    MAX_TRACKED_ESCALATIONS,
  );
  await store.set(ESCALATION_INDEX_KEY, next);
  return true;
}

/**
 * Clears the escalation flag for an item (e.g. once a senior reviewer has
 * actioned it). Returns true if an entry was removed.
 */
export async function unescalateItem(kind, id) {
  const escalated = (await store.get(ESCALATION_INDEX_KEY)) || [];
  const next = escalated.filter((e) => !(e.kind === kind && e.id === id));
  if (next.length === escalated.length) return false;
  await store.set(ESCALATION_INDEX_KEY, next);
  return true;
}

/**
 * Returns the raw escalation entries ({ kind, id, escalatedAt }), most-recent
 * first. Backs the admin listing endpoints, which use this to mark escalated
 * items so an escalated item is distinguishable from an unescalated one.
 */
export async function getEscalatedItems() {
  return (await store.get(ESCALATION_INDEX_KEY)) || [];
}

/**
 * Returns the set of escalated ids for a given kind, for cheap membership
 * checks when annotating admin listings.
 */
export async function getEscalatedIds(kind) {
  const escalated = await getEscalatedItems();
  return new Set(escalated.filter((e) => e.kind === kind).map((e) => e.id));
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
  const settled = await settle(job, outcome);
  await unindexReview(jobId);
  await unescalateItem('review', jobId);
  return settled;
}

import { store } from './store.js';
import { config } from './config.js';
import { settlementsTotal } from './metrics.js';

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

// Scheduled-question index (#80). Holds the jobIds of questions that have been
// paid for up front but whose dispatch is deferred to a future execute time.
// Same bounded durable-index pattern as the indexes above; entries are removed
// once the job is dispatched (or cancelled). The sweep in scheduled.js reads
// this list and dispatches any job whose `scheduledFor` has arrived.
const SCHEDULED_INDEX_KEY = 'scheduled-job-ids';
const MAX_TRACKED_SCHEDULED = 5_000;

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

// gRPC job-status streaming (issue #76). A gRPC server-streaming call needs to
// be woken whenever a job's status changes, rather than polling the store on
// an interval. updateJob() is the single choke point every state transition
// (awaiting_workers -> reconciling -> settled, plus holding/pending_review)
// already flows through, so we fan out change notifications from there. This
// keeps the gRPC stream reflecting exactly the same transitions the REST
// GET /oracle/:jobId polling endpoint shows, without reimplementing any of
// the state machine. Listeners are in-process only (the gRPC server runs in
// the same process as Express), so a plain Map of Sets is sufficient.
const jobStatusListeners = new Map();

/**
 * Subscribe to status changes for a single job. Returns an unsubscribe
 * function. Used by the gRPC server-streaming handler to push updates as
 * updateJob() writes them.
 */
export function onJobStatusChange(jobId, listener) {
  let set = jobStatusListeners.get(jobId);
  if (!set) {
    set = new Set();
    jobStatusListeners.set(jobId, set);
  }
  set.add(listener);
  return () => {
    const current = jobStatusListeners.get(jobId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) jobStatusListeners.delete(jobId);
  };
}

function notifyJobStatusChange(jobId, job) {
  const set = jobStatusListeners.get(jobId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(job);
    } catch {
      // A misbehaving listener must never break the state transition itself.
    }
  }
}

async function indexJob(jobId) {
  const known = (await store.get(JOB_INDEX_KEY)) || [];
  if (known.includes(jobId)) return;
  await store.set(JOB_INDEX_KEY, [jobId, ...known].slice(0, MAX_TRACKED_JOBS));
}

export async function getKnownJobIds(readStore = store) {
  return (await readStore.get(JOB_INDEX_KEY)) || [];
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
 * Tags a job as synthetic monitoring (issue #111). Idempotent. Synthetic jobs
 * are excluded from /stats the same way sandbox settlements are, so a
 * monitoring run never inflates real customer metrics.
 */
export async function markSynthetic(jobId) {
  const synthetic = (await store.get(SYNTHETIC_INDEX_KEY)) || [];
  if (synthetic.includes(jobId)) return;
  await store.set(
    SYNTHETIC_INDEX_KEY,
    [jobId, ...synthetic].slice(0, MAX_TRACKED_SYNTHETIC_JOBS),
  );
}

/**
 * Returns the jobIds tagged as synthetic monitoring, most-recent-first.
 * Backs /stats' exclusion of synthetic runs.
 */
export async function getSyntheticJobIds() {
  return (await store.get(SYNTHETIC_INDEX_KEY)) || [];
}

/**
 * True if the given jobId was tagged as synthetic monitoring. Used by /stats
 * to exclude synthetic runs from real customer metrics.
 */
export async function isSyntheticJob(jobId) {
  const synthetic = (await store.get(SYNTHETIC_INDEX_KEY)) || [];
  return synthetic.includes(jobId);
}

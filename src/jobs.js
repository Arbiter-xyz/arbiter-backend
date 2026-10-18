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

// Scheduled-question index (#80). Holds the jobIds of questions that have been
// paid for up front but whose dispatch is deferred to a future execute time.
// Same bounded durable-index pattern as the indexes above; entries are removed
// once the job is dispatched (or cancelled). The sweep in scheduled.js reads
// this list and dispatches any job whose `scheduledFor` has arrived.
const SCHEDULED_INDEX_KEY = 'scheduled-job-ids';
const MAX_TRACKED_SCHEDULED = 5_000;

// gRPC job-status streaming (issue #76). A gRPC server-streaming call needs to
// be woken whenever a job's status changes, rather than polling the store on
// an interval. updateJob() is the single choke point every state transition
// (awaiting_workers -> reconciling -> settled, plus holding/scheduled)
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

export async function getKnownJobIds() {
  return (await store.get(JOB_INDEX_KEY)) || [];
}

async function indexScheduled(jobId) {
  const scheduled = (await store.get(SCHEDULED_INDEX_KEY)) || [];
  if (scheduled.includes(jobId)) return;
  await store.set(
    SCHEDULED_INDEX_KEY,
    [jobId, ...scheduled].slice(0, MAX_TRACKED_SCHEDULED),
  );
}

async function unindexScheduled(jobId) {
  const scheduled = (await store.get(SCHEDULED_INDEX_KEY)) || [];
  if (!scheduled.includes(jobId)) return;
  await store.set(SCHEDULED_INDEX_KEY, scheduled.filter((id) => id !== jobId));
}

/**
 * Returns the jobIds currently in the `scheduled` state, most-recent-first.
 * Backs the scheduling sweep (scheduled.js), which dispatches any job whose
 * `scheduledFor` has arrived and prunes entries that have left the state.
 */
export async function getScheduledJobIds() {
  return (await store.get(SCHEDULED_INDEX_KEY)) || [];
}

/**
 * Returns the full job records currently in `scheduled`, sorted by execute
 * time ascending (soonest first). Jobs whose record has expired (TTL) or
 * already left the scheduled state are pruned from the index so the queue
 * self-heals.
 */
export async function getScheduledJobs() {
  const jobIds = await getScheduledJobIds();
  const jobs = [];
  for (const jobId of jobIds) {
    const job = await getJob(jobId);
    if (job && job.status === 'scheduled') {
      jobs.push(job);
    } else {
      await unindexScheduled(jobId);
    }
  }
  return jobs.sort((a, b) => (a.scheduledFor || 0) - (b.scheduledFor || 0));
}

/**
 * Cancels a scheduled question before its dispatch time. Only valid while the
 * job is still in `scheduled` — once the sweep has moved it to
 * `awaiting_workers` the normal undo window / refund path applies instead.
 * Returns the updated job, or null if the job is missing or no longer
 * cancellable. Releasing reserved funds is the caller's responsibility (the
 * route layer refunds the prepaid charge); this only flips the state and
 * removes the job from the schedule index so it is never dispatched.
 */
export async function cancelScheduledJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'scheduled') return null;
  const updated = await updateJob(jobId, {
    status: 'cancelled',
    cancelledAt: Date.now(),
  });
  await unindexScheduled(jobId);
  return updated;
}

/**
 * Async job record for a paid question. Replaces v1's design of holding the
 * client's HTTP request open for up to QUORUM_TIMEOUT_MS while workers
 * answer — that's fragile against proxies, mobile networks, and
 * serverless/edge request timeouts. Instead POST /oracle's second step
 * returns 202 immediately once payment is confirmed, and the caller polls
 * GET /oracle/:jobId (or listens on its SSE stream) for the result.
 *
 * States: [holding ->] [scheduled ->] awaiting_workers -> reconciling -> settled
 * `holding` is the undo window (see undoWindow.js) — paid, not yet
 * dispatched, cancellable until `cancellableUntil`; a cancelled job goes
 * holding -> cancelling -> settled instead.
 * `scheduled` (#80) is a paid question whose dispatch is deferred to
 * `scheduledFor`; the scheduling sweep moves it to `awaiting_workers` at
 * that time, after which the normal pipeline applies. A scheduled job
 * cancelled before `scheduledFor` goes straight to `cancelled` without ever
 * dispatching.
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
    // Which process owns this job's collectors/timers — what a blue-green
    // drain counts (deployment.js's createInFlightCounter).
    instanceId: config.deploy.instanceId,
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
  if (next.status === 'settled' && current.status !== 'settled') {
    settlementsTotal.inc({ outcome: next.outcome || 'unknown' });
  }
  notifyJobStatusChange(jobId, next);
  return next;
}

export async function getJob(jobId) {
  return store.get(PREFIX + jobId);
}


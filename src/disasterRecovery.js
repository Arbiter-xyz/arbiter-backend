import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import {
  RECOVERY_REASONS,
  onchainPendingQuestions,
  recoveryActionable,
  recoveryRefundsTotal,
  recoverySweepLastSuccess,
  recoverySweepFailuresTotal,
} from './metrics.js';

/**
 * Recovery from total backend state loss (docs/runbooks/disaster-recovery.md).
 *
 * The existing crash-safety design (jobs.js's reconcileJobs, reconcile.js's
 * recoverInFlightJobs) walks the LOCAL job index and checks each job against
 * the chain. That covers a crash, not a lost Redis: when the store is wiped,
 * the job index, every pending-question stash, and every job record go with
 * it, and there is nothing left locally to walk. Payers who already paid are
 * then stranded until their question's refund_timeout() window opens, and
 * nobody is told.
 *
 * This sweep inverts the direction: it starts from the CHAIN — the
 * contract's on-chain Pending-question index (pending_count/list_pending,
 * arbiter-contract v0.3.0+) — and asks, for every question still holding a
 * payer's funds, whether anything local can still settle it. Only a question
 * nothing local can ever serve again is refunded, through the same
 * admin-only refund() the fail-closed path already uses. The chain is the
 * source of truth for money; local state is only consulted to decide whether
 * it's safe to act.
 *
 * Classification of a question that is Pending on-chain:
 *
 *   local job in flight (holding/awaiting_workers/reconciling/cancelling)
 *     -> skip 'inflight'           the normal pipeline owns it
 *        ... unless it hasn't been touched for staleInflightMs
 *     -> refund 'stale_inflight'   the process that owned it died mid-flight
 *   local job settled with outcome refund_pending_timeout
 *     -> refund 'failed_settlement' both resolve() and refund() failed earlier
 *   local job settled with any other outcome
 *     -> flag 'inconsistent'       local says settled, chain says Pending:
 *                                  never auto-refund, a human must look
 *   no job, but a pending-question stash
 *     -> skip 'awaiting_submission' payer paid and may still call step 2;
 *                                  the stash's own TTL turns this into an
 *                                  orphan if they never do
 *   no job, no stash, opened < minAgeLedgers ago
 *     -> skip 'too_young'          guards the gap between submit() landing
 *                                  and this instance's store seeing the stash
 *   no job, no stash
 *     -> refund 'orphaned'         state was lost (or expired): this backend
 *                                  can never dispatch it, since step 2
 *                                  requires the stash
 *
 * Every refund re-reads the question's on-chain status immediately before
 * calling refund(), and refund() itself rejects a non-Pending question
 * (QuestionNotPending), so a concurrent settlement can never be doubled.
 */

export const INFLIGHT_STATUSES = new Set(['holding', 'awaiting_workers', 'reconciling', 'cancelling']);

export const DEFAULT_SWEEP_OPTIONS = Object.freeze({
  // ~1 minute of 5s ledgers.
  minAgeLedgers: 12,
  // Far longer than any tier's quorum window plus the undo window: a job
  // untouched for this long has no live process driving it.
  staleInflightMs: 30 * 60 * 1000,
  // Bounds fee spend (one admin tx per refund) if something upstream is
  // badly wrong; the next sweep picks up the remainder.
  maxRefundsPerSweep: 50,
  pageSize: 100,
});

/** Pure classification of one on-chain Pending question. */
export function classifyPendingQuestion({ question, job, stash, currentLedger }, options = {}) {
  const { minAgeLedgers, staleInflightMs } = { ...DEFAULT_SWEEP_OPTIONS, ...options };
  const now = options.now ?? Date.now();

  if (!question || question.status !== 'pending') return { action: 'skip', reason: 'not_pending' };

  if (job) {
    if (INFLIGHT_STATUSES.has(job.status)) {
      const lastTouched = job.updatedAt ?? job.createdAt ?? 0;
      return now - lastTouched >= staleInflightMs
        ? { action: 'refund', reason: 'stale_inflight' }
        : { action: 'skip', reason: 'inflight' };
    }
    if (job.status === 'settled') {
      return job.outcome === 'refund_pending_timeout'
        ? { action: 'refund', reason: 'failed_settlement' }
        : { action: 'flag', reason: 'inconsistent' };
    }
    // Unknown status: never guess with someone's money.
    return { action: 'flag', reason: 'inconsistent' };
  }

  if (stash) return { action: 'skip', reason: 'awaiting_submission' };

  if (currentLedger != null && question.createdAt != null && currentLedger - question.createdAt < minAgeLedgers) {
    return { action: 'skip', reason: 'too_young' };
  }

  return { action: 'refund', reason: 'orphaned' };
}

/**
 * Reads the whole on-chain Pending index. list_pending uses swap-remove, so
 * a settlement between two page reads can move an id across pages; the
 * count is re-read after paging and the scan retried if it moved.
 *
 * If every attempt is inconsistent, the snapshot is NOT a complete view of
 * the Pending set: it may be missing ids that churned across pages. Callers
 * must treat `consistent: false` as "incomplete" — the sweep skips acting on
 * it (an incomplete snapshot could silently under-refund, or worse, misjudge
 * a question's local state) and lets the next sweep retry. The partial ids
 * are still returned for diagnostics.
 */
export async function snapshotPendingIds({ getPendingCount, listPending }, { pageSize = 100, attempts = 3 } = {}) {
  let ids = new Set();
  let lastCount = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ids = new Set();
    const before = await getPendingCount();
    for (let start = 0; start < before; start += pageSize) {
      for (const id of await listPending(start, pageSize)) ids.add(String(id));
    }
    const after = await getPendingCount();
    lastCount = after;
    if (before === after) return { ids: [...ids], count: after, consistent: true };
  }
  return { ids: [...ids], count: lastCount, consistent: false };
}

/**
 * One sweep. `deps` (all async unless noted):
 *   getPendingCount(), listPending(start, limit)       on-chain index
 *   getQuestion(id) -> { status, payer, amount, createdAt } | null
 *   getLatestLedger() -> number
 *   getJob(id), getStash(id)                           local state
 *   refund(id) -> { hash }                             admin refund()
 *   recordRefund(id, { reason, hash, question, job })  persist the outcome
 *
 * With `dryRun`, classifies everything and refunds nothing.
 */
export async function sweepPendingQuestions(deps, options = {}) {
  const opts = { ...DEFAULT_SWEEP_OPTIONS, ...options };
  const startedAt = Date.now();

  const snapshot = await snapshotPendingIds(deps, { pageSize: opts.pageSize });
  if (!snapshot.consistent) {
    // The Pending index churned across every scan attempt, so this snapshot
    // may be missing ids. Acting on it would silently under-refund (or skip)
    // stranded payers; fail loudly and let the next sweep retry.
    recoverySweepFailuresTotal.inc({ reason: 'inconsistent_snapshot' });
    logger.warn(
      { scanned: snapshot.ids.length, count: snapshot.count },
      'disaster recovery: pending index inconsistent across all scan attempts; skipping sweep',
    );
    return {
      startedAt,
      finishedAt: Date.now(),
      consistent: false,
      scanned: snapshot.ids.length,
      items: [],
      refundsAttempted: 0,
    };
  }

  const currentLedger = await deps.getLatestLedger();

  const items = [];
  let refundsAttempted = 0;

  for (const questionId of snapshot.ids) {
    const item = { questionId };
    items.push(item);
    try {
      const question = await deps.getQuestion(questionId);
      const [job, stash] = await Promise.all([deps.getJob(questionId), deps.getStash(questionId)]);
      const { action, reason } = classifyPendingQuestion(
        { question, job, stash, currentLedger },
        { ...opts, now: opts.now ?? Date.now() },
      );
      Object.assign(item, {
        action,
        reason,
        payer: question?.payer ?? null,
        amountStroops: question?.amount != null ? String(question.amount) : null,
        createdAtLedger: question?.createdAt ?? null,
        localJobStatus: job?.status ?? null,
      });

      if (action !== 'refund' || opts.dryRun) continue;
      if (refundsAttempted >= opts.maxRefundsPerSweep) {
        item.result = 'deferred';
        continue;
      }
      refundsAttempted += 1;

      // Re-read right before acting: a concurrent resolve()/refund() (this
      // or another instance) may have landed since the classification read.
      const fresh = await deps.getQuestion(questionId);
      if (!fresh || fresh.status !== 'pending') {
        item.result = 'already_settled';
        continue;
      }

      const { hash } = await deps.refund(questionId);
      item.result = 'ok';
      item.refundTx = hash;
      await deps.recordRefund(questionId, { reason, hash,

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
 * count is re-read after paging and the scan retried if it moved. An id
 * missed by an inconsistent scan is simply picked up by the next sweep.
 */
export async function snapshotPendingIds({ getPendingCount, listPending }, { pageSize = 100, attempts = 3 } = {}) {
  let ids = new Set();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ids = new Set();
    const before = await getPendingCount();
    for (let start = 0; start < before; start += pageSize) {
      for (const id of await listPending(start, pageSize)) ids.add(String(id));
    }
    const after = await getPendingCount();
    if (before === after) return { ids: [...ids], count: after, consistent: true };
  }
  return { ids: [...ids], count: ids.size, consistent: false };
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
      await deps.recordRefund(questionId, { reason, hash, question: fresh, job });
    } catch (err) {
      item.result = 'error';
      item.error = err.message;
      logger.error({ err, questionId }, 'recovery sweep: failed to handle pending question');
    }
  }

  return {
    dryRun: Boolean(opts.dryRun),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    currentLedger,
    onChainPending: snapshot.count,
    consistentSnapshot: snapshot.consistent,
    items,
    summary: summarize(items),
  };
}

function summarize(items) {
  const summary = { refunded: 0, alreadySettled: 0, errors: 0, deferred: 0, skipped: 0, flagged: 0, byReason: {} };
  for (const item of items) {
    if (item.reason) summary.byReason[item.reason] = (summary.byReason[item.reason] || 0) + 1;
    if (item.action === 'skip') summary.skipped += 1;
    if (item.action === 'flag') summary.flagged += 1;
    if (item.result === 'ok') summary.refunded += 1;
    if (item.result === 'already_settled') summary.alreadySettled += 1;
    if (item.result === 'error') summary.errors += 1;
    if (item.result === 'deferred') summary.deferred += 1;
  }
  return summary;
}

/** Publishes a (non-dry-run) sweep's outcome. The actionable gauge counts
 * what is STILL stranded after this sweep acted — so a sweep that refunded
 * everything drops it back to 0, and one whose refunds keep failing holds it
 * up long enough for EscrowOrphaned to fire. */
export function recordSweepMetrics(report) {
  onchainPendingQuestions.set(report.onChainPending);
  const remaining = Object.fromEntries(RECOVERY_REASONS.map((r) => [r, 0]));
  for (const item of report.items) {
    if (item.action === 'flag' || (item.action === 'refund' && item.result !== 'ok' && item.result !== 'already_settled')) {
      remaining[item.reason] += 1;
    }
    if (item.action === 'refund' && item.result && item.result !== 'deferred') {
      recoveryRefundsTotal.inc({ reason: item.reason, result: item.result });
    }
  }
  for (const [reason, count] of Object.entries(remaining)) recoveryActionable.set({ reason }, count);
  recoverySweepLastSuccess.set(Date.now() / 1000);
}

const LOCK_KEY = 'recovery:sweep-lock';
const instanceId = randomUUID();

/**
 * A sweep guarded by a store lock (so replicas sharing Redis don't each
 * refund the same orphan — harmless on-chain, since the second refund()
 * fails QuestionNotPending, but it burns a fee and pages someone for
 * nothing), with metrics. Returns null when another instance holds the lock.
 */
export async function runRecoverySweep({ store, deps, options = {}, lockTtlMs = 10 * 60 * 1000 }) {
  if (!options.dryRun) {
    const acquired = await store.setNX(LOCK_KEY, instanceId, lockTtlMs);
    if (!acquired) return null;
  }
  try {
    const report = await sweepPendingQuestions(deps, options);
    if (!report.dryRun) recordSweepMetrics(report);
    logger.info({ summary: report.summary, onChainPending: report.onChainPending, dryRun: report.dryRun }, 'recovery sweep complete');
    return report;
  } catch (err) {
    recoverySweepFailuresTotal.inc();
    logger.error({ err }, 'recovery sweep could not scan the chain');
    throw err;
  } finally {
    if (!options.dryRun) await store.delete(LOCK_KEY);
  }
}

/**
 * The real dependencies, wired to stellarClient/jobs/pendingQuestions.
 * Imported lazily so this module (and its tests) never pull in the store,
 * the RPC client or config at import time.
 */
export async function defaultRecoveryDeps() {
  const chain = await import('./stellarClient.js');
  const jobs = await import('./jobs.js');
  const pending = await import('./pendingQuestions.js');
  const { incrementStat } = await import('./stats.js');

  return {
    getPendingCount: chain.getPendingCountOnChain,
    listPending: chain.listPendingOnChain,
    getQuestion: chain.getQuestionOnChain,
    getLatestLedger: chain.getLatestLedgerSequence,
    getJob: jobs.getJob,
    getStash: pending.getStashedQuestion,
    refund: chain.refundQuestion,
    async recordRefund(questionId, { reason, hash, question, job }) {
      const fields = {
        status: 'settled',
        outcome: 'refunded',
        refundTx: hash,
        recovered: true,
        recoveryReason: reason,
        reason: RECOVERY_REASON_TEXT[reason],
        settledAt: Date.now(),
      };
      if (job) {
        await jobs.updateJob(questionId, fields);
      } else {
        // Nothing survived locally: rebuild enough of the record that the
        // payer's GET /oracle/:jobId poll ends in a settled refund instead
        // of a 404, from what the chain still knows.
        await jobs.createJob(questionId, {
          questionId,
          payer: question.payer,
          amountStroops: String(question.amount),
          ...fields,
        });
      }
      await pending.dropStashedQuestion(questionId);
      await incrementStat('refunded');
    },
  };
}

const RECOVERY_REASON_TEXT = {
  orphaned: 'refunded by disaster recovery: the backend no longer had any record of this paid question',
  stale_inflight: 'refunded by disaster recovery: the backend stopped processing this question mid-flight',
  failed_settlement: 'refunded by disaster recovery: the original on-chain settlement failed',
};

/** Periodic sweep. The first run happens immediately, so a backend that just
 * came up on an empty store starts refunding stranded payers at once. */
export function startRecoverySweeper({ store, intervalMs, options = {} }) {
  let depsPromise = null;
  const run = async () => {
    depsPromise ??= defaultRecoveryDeps();
    try {
      await runRecoverySweep({ store, deps: await depsPromise, options });
    } catch {
      // Already logged and counted in runRecoverySweep.
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

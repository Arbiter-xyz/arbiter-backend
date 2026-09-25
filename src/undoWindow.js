import { store } from './store.js';
import { config } from './config.js';

/**
 * The undo window: a short hold between a paid question's job being created
 * and it being dispatched to workers, during which the payer can cancel and
 * be refunded (see oracle.js's startFulfillment/cancelJob).
 *
 * Payment has ALREADY landed on-chain by the time a job reaches this point
 * (submit() or charge() opened the escrowed Question), so "undo" can't mean
 * "don't charge" — it means "never dispatch, and refund through the same
 * refundQuestion() path any other refund takes."
 *
 * The one hard requirement is that "cancel" and "dispatch" can never both
 * happen for the same job: a cancel landing a millisecond after the hold
 * timer fired must not refund a question workers are already answering,
 * and a timer firing just after a cancel must not dispatch a refunded one.
 * Both sides therefore go through claimUndoDecision(), the same atomic
 * store.incr() "first caller wins" primitive jobs.js's claimJob() uses for
 * fulfillment idempotency — so it also holds across instances sharing a
 * Redis store, even though the hold timer itself is process-local.
 *
 * Known limitation, same as every other in-process timer in this backend
 * (dispatch.js's quorum collectors): if the process restarts mid-hold, the
 * timer is lost and the job stays 'holding'. Nothing is dispatched and the
 * payer's funds stay escrowed, so the contract's permissionless
 * refund_timeout() is the recovery path — exactly as for a question whose
 * dispatch was interrupted by a restart today.
 */

const DECISION_PREFIX = 'undo-decision:';
const timers = new Map(); // jobId -> hold timer (process-local)

/** How long `tier` is held before dispatch. The instant tier is never held:
 * it settles in a single Claude round-trip and that call is billed whether
 * or not its answer is used, so a hold there would only add latency to the
 * one tier whose whole promise is speed, while saving the payer nothing. */
export function undoWindowFor(tier, holdMs = config.undoWindowMs) {
  if (!tier || tier.instant) return 0;
  return Math.max(0, Number(holdMs) || 0);
}

/** Atomically records `decision` ('dispatch' | 'cancel') for a held job.
 * Returns true only for the first caller; every later call — including the
 * other decision racing it — gets false and must do nothing. */
export async function claimUndoDecision(jobId, decision) {
  const count = await store.incr(`${DECISION_PREFIX}${jobId}`, config.jobResultTtlMs);
  if (count !== 1) return false;
  await store.set(`${DECISION_PREFIX}${jobId}:winner`, decision, config.jobResultTtlMs);
  return true;
}

/** Which decision won for a job, or null if the hold is still open. */
export async function getUndoDecision(jobId) {
  return store.get(`${DECISION_PREFIX}${jobId}:winner`);
}

/**
 * Runs `dispatch` after `holdMs`, unless a cancel claims the job first.
 * `onError` receives anything `dispatch` throws — there's no caller left
 * to await it once the timer fires.
 */
export function holdThenDispatch(jobId, holdMs, dispatch, onError = () => {}) {
  const timer = setTimeout(async () => {
    timers.delete(jobId);
    try {
      if (await claimUndoDecision(jobId, 'dispatch')) await dispatch();
    } catch (err) {
      onError(err);
    }
  }, holdMs);
  timers.set(jobId, timer);
}

/**
 * Cancels a held job: claims the 'cancel' decision and, only if that claim
 * wins, stops the local hold timer and runs `refund`. Resolves
 * `{ cancelled: false }` without calling `refund` if dispatch already won.
 */
export async function cancelHeld(jobId, refund) {
  if (!(await claimUndoDecision(jobId, 'cancel'))) return { cancelled: false };
  clearTimeout(timers.get(jobId));
  timers.delete(jobId);
  await refund();
  return { cancelled: true };
}

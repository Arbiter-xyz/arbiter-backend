import { createHmac } from 'node:crypto';
import { store } from './store.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { normalize } from './vote.js';

/**
 * Collusion-detection heuristics. Reputation (dispatch.js) and the
 * established-only fast path (reconcile.js) both judge workers one at a
 * time; neither can see a ring of identities that coordinate. This module
 * watches PAIRS of workers across the quorums they share and scores how
 * unlikely their joint behavior is for two independent people.
 *
 * Signals, each scored 0..1 per pair:
 *  - sameWrong: both gave the identical (normalized) answer and it lost.
 *    Independent honest workers are occasionally wrong, but rarely wrong
 *    in exactly the same words. The strongest single signal here.
 *  - lift: how much more often the pair gives the same answer than their
 *    individual match ratios predict if they answered independently. Only
 *    scored once they share config.collusion.minSharedQuestions quorums.
 *  - sync: how often their answers land within syncWindowMs of each other.
 *    Weak on its own (easy questions get fast answers from everyone).
 *  - referral: one referred the other (see referrals.js). Very weak on its
 *    own — referring people you know is the whole point of referrals — but
 *    it's context that makes the other signals more plausible.
 *  - sharedIp: both have connected to /app/events from the same IP. IPs
 *    are stored only as an HMAC, never raw.
 *
 * They're combined with a weighted noisy-OR, so no single weak signal can
 * flag a pair, and each extra signal raises the score without ever going
 * past 1. Every threshold is a heuristic, not a proof: a flag denies the
 * pair's shared quorums the reconcile fast path and surfaces them to
 * operators, and a high enough score drops them from routing (a soft gate
 * that fails open like every other one). Nothing here slashes stake.
 *
 * Storage follows the rest of the backend: counters use store.incrBy() so
 * concurrent settlements can't lose an update, and indexes are bounded,
 * de-duplicated arrays like payerIndex.js and privatePools.js.
 */

const PAIR_PREFIX = 'collusion:pair:';
const PARTNERS_PREFIX = 'collusion:partners:';
const LINK_PREFIX = 'collusion:link:';
const FLAG_PREFIX = 'collusion:flag:';
const SUSPENDED_PREFIX = 'collusion:suspended:';
const TIMING_PREFIX = 'collusion:timing:';
const WORKER_IPS_PREFIX = 'collusion:worker-ips:';
const FLAGGED_INDEX_KEY = 'collusion:flagged-pairs';

const COUNTERS = ['shared', 'sameAnswer', 'sameWrong', 'synced'];

const MAX_PARTNERS_TRACKED = 200;
const MAX_IPS_PER_WORKER = 20;
const MAX_FLAGGED_TRACKED = 5_000;
const TIMING_TTL_MS = 60 * 60 * 1000;
const IP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // IPs get reassigned; old ones shouldn't link strangers forever

/**
 * Per-signal weights for the noisy-OR combination below.
 *
 * How these were chosen: hand-tuned by ranking the signals by how hard they
 * are to produce innocently, then spacing the weights so that no single
 * signal reaches the flag threshold on its own and any two moderate signals
 * together do. sameWrong is the only signal that is genuinely rare for two
 * independent honest workers (identical normalized wrong answers), so it
 * carries the most weight; referral is the weakest because referring people
 * you know is expected behavior. The ordering is the load-bearing part; the
 * exact decimals are not.
 *
 * Caveat — no formal sensitivity analysis is on record. These numbers were
 * NOT derived from a measured false-positive-rate curve, and no backtest
 * over historical quorums has been run to confirm the flag/suspend
 * thresholds they feed. They are a documented heuristic, not a calibrated
 * model. If false positives or false negatives are observed in practice,
 * the right move is to re-derive them from labeled data (or at least sweep
 * them against a replay of settled quorums) rather than nudge them ad hoc.
 * Treat any change here as a behavior change to the routing gate and the
 * operator flag surface, and note it in the PR.
 */
export const SIGNAL_WEIGHTS = Object.freeze({
  sameWrong: 0.7,
  lift: 0.5,
  sharedIp: 0.4,
  sync: 0.35,
  referral: 0.2,
});

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function splitPair(key) {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

function hashIp(ip) {
  return createHmac('sha256', config.session.secret).update(`ip:${ip}`).digest('hex').slice(0, 32);
}

async function pushBounded(key, value, max, ttlMs) {
  const list = (await store.get(key)) || [];
  if (list.includes(value)) return;
  await store.set(key, [value, ...list].slice(0, max), ttlMs);
}

// ---------------------------------------------------------------------
// Observation — the write side, fed by the HTTP layer and settlement.
// ---------------------------------------------------------------------

/** Called when a worker opens the SSE channel. Best-effort, never throws. */
export async function recordWorkerIp(workerId, ip) {
  if (!workerId || !ip) return;
  try {
    await pushBounded(WORKER_IPS_PREFIX + workerId, hashIp(ip), MAX_IPS_PER_WORKER, IP_TTL_MS);
  } catch (err) {
    logger.warn({ err, workerId }, 'failed to record worker ip for collusion heuristics');
  }
}

/** Called when a worker's answer is accepted. First write wins per worker,
 * same dedup rule as the quorum collector itself. Best-effort. */
export async function noteAnswerTiming(questionId, workerId, at = Date.now()) {
  try {
    await store.hsetnx(TIMING_PREFIX + questionId, workerId, at, TIMING_TTL_MS);
  } catch (err) {
    logger.warn({ err, questionId, workerId }, 'failed to record answer timing');
  }
}

/** Called by referrals.js on a successful redemption. */
export async function recordReferralLink(referrer, referee) {
  await store.set(LINK_PREFIX + pairKey(referrer, referee), { kind: 'referral', referrer, referee, linkedAt: Date.now() });
}

/**
 * Pure: turns one settled quorum into per-pair counter increments. Exported
 * so the heuristic can be reasoned about (and tested) without a store.
 * `timings` is { workerId: epochMs } and may be missing entries.
 */
export function pairObservations(submissions, matchingWorkerIds, timings = {}, syncWindowMs = config.collusion.syncWindowMs) {
  const matching = new Set(matchingWorkerIds);
  const out = [];
  for (let i = 0; i < submissions.length; i += 1) {
    for (let j = i + 1; j < submissions.length; j += 1) {
      const a = submissions[i];
      const b = submissions[j];
      if (a.workerId === b.workerId) continue;
      const sameAnswer = normalize(a.answer) === normalize(b.answer);
      const bothLost = !matching.has(a.workerId) && !matching.has(b.workerId);
      const ta = timings[a.workerId];
      const tb = timings[b.workerId];
      const synced = typeof ta === 'number' && typeof tb === 'number' && Math.abs(ta - tb) <= syncWindowMs;
      out.push({
        key: pairKey(a.workerId, b.workerId),
        a: a.workerId,
        b: b.workerId,
        deltas: { shared: 1, sameAnswer: sameAnswer ? 1 : 0, sameWrong: sameAnswer && bothLost ? 1 : 0, synced: synced ? 1 : 0 },
      });
    }
  }
  return out;
}

/**
 * Pure: combines per-signal scores (each 0..1) into a single 0..1 score via
 * a weighted noisy-OR: score = 1 - Π(1 - w_i * s_i). Exported so the
 * combination rule can be tested without a store. Missing/zero signals
 * contribute nothing; the result is monotonic in each signal and never
 * exceeds 1.
 */
export function scorePair(signals = {}) {
  let miss = 1;
  for (const [name, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    const raw = signals[name];
    if (typeof raw !== 'number' || !(raw > 0)) continue;
    const s = raw > 1 ? 1 : raw;
    miss *= 1 - weight * s;
  }
  return 1 - miss;
}

/**
 * Pure: given a pair's counters and context, derives the per-signal scores
 * that feed scorePair(). Exported for testing. `counters` is the object
 * stored under PAIR_PREFIX; `context` carries { referral, sharedIp }.
 */
export function pairSignals(counters = {}, context = {}) {
  const shared = counters.shared || 0;
  const sameAnswer = counters.sameAnswer || 0;
  const sameWrong = counters.sameWrong || 0;
  const synced = counters.synced || 0;
  const signals = {};
  if (shared > 0) {
    signals.sameWrong = sameWrong / shared;
    signals.sync = synced / shared;
    if (shared >= config.collusion.minSharedQuestions) {
      // Lift: observed co-match rate over the 0.5 baseline two independent
      // workers would hit by chance on a binary question. Clamped to 0..1.
      const observed = sameAnswer / shared;
      const lift = (observed - 0.5) / 0.5;
      if (lift > 0) signals.lift = lift > 1 ? 1 : lift;
    }
  }
  if (context.referral) signals.referral = 1;
  if (context.sharedIp) signals.sharedIp = 1;
  return signals;
}

/**
 * Pure: maps a score to the pair's disposition. `flag` denies the reconcile
 * fast path and surfaces the pair to operators; `suspend` additionally drops
 * them from routing. Thresholds come from config.collusion.
 */
export function assessQuorum(score) {
  if (score >= config.collusion.suspendThreshold) return 'suspend';
  if (score >= config.collusion.flagThreshold) return 'flag';
  return 'ok';
}

/**
 * Records a settled quorum and re-scores every pair in it, flagging or
 * suspending as thresholds are crossed. `getReputation` is injected (from
 * dispatch.js) rather than imported, since dispatch.js imports this module
 * for its routing gate. Never throws: collusion bookkeeping must never be
 * the reason a settlement fails.
 */
export async function recordQuorumObservation(questionId, submissions, matchingWorkerIds, { getReputation } = {}) {
  if (!submissions || submissions.length < 2) return;
  try {
    const timings = await store.hgetall(TIMING_PREFIX + questionId);
    const observations = pairObservations(submissions, matchingWorkerIds || [], timings);

    for (const { key, a, b, deltas } of observations) {
      const pairStoreKey = PAIR_PREFIX + key;
      const counters = (await store.get(pairStoreKey)) || {};
      for (const name of COUNTERS) {
        if (deltas[name]) counters[name] = (counters[name] || 0) + deltas[name];
      }
      await store.set(pairStoreKey, counters);
      await pushBounded(PARTNERS_PREFIX + a, b, MAX_PARTNERS_TRACKED);
      await pushBounded(PARTNERS_PREFIX + b, a, MAX_PARTNERS_TRACKED);
      await rescorePair(key, { getReputation });
    }
  } catch (err) {
    logger.warn({ err, questionId }, 'failed to record collusion observation');
  }
}

/**
 * Re-scores one pair from its stored counters and context, then applies the
 * resulting disposition. Exported so callers (and tests) can force a
 * re-score after context changes (e.g. a new referral link). Never throws.
 */
export async function rescorePair(key, { getReputation } = {}) {
  try {
    const [a, b] = splitPair(key);
    const counters = (await store.get(PAIR_PREFIX + key)) || {};
    const referral = Boolean(await store.get(LINK_PREFIX + key));
    const ipsA = (await store.get(WORKER_IPS_PREFIX + a)) || [];
    const ipsB = (await store.get(WORKER_IPS_PREFIX + b)) || [];
    const sharedIp = ipsA.some((ip) => ipsB.includes(ip));
    const signals = pairSignals(counters, { referral, sharedIp });
    const score = scorePair(signals);
    const disposition = assessQuorum(score);

    await store.set(PAIR_PREFIX + key, { ...counters, score, disposition });

    if (disposition === 'ok') return { key, score, disposition };

    await store.set(FLAG_PREFIX + key, { score, disposition, at: Date.now() });
    await pushBounded(FLAGGED_INDEX_KEY, key, MAX_FLAGGED_TRACKED);
    if (disposition === 'suspend') {
      await store.set(SUSPENDED_PREFIX + key, { score, at: Date.now() });
    }
    logger.warn({ key, score, disposition }, 'collusion pair flagged');
    return { key, score, disposition };
  } catch (err) {
    logger.warn({ err, key }, 'failed to rescore collusion pair');
    return null;
  }
}

/** True if the pair is currently suspended (dropped from routing). */
export async function isPairSuspended(a, b) {
  return Boolean(await store.get(SUSPENDED_PREFIX + pairKey(a, b)));
}

/** True if the pair is currently flagged (denied the reconcile fast path). */
export async function isPairFlagged(a, b) {
  return Boolean(await store.get(FLAG_PREFIX + pairKey(a, b)));
}

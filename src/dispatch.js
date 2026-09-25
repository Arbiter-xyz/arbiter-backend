import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { getStakeOnChain, touchWorker } from './stellarClient.js';
import { jobLogger, logger } from './logger.js';
import { exactMatchVote } from './reconcile.js';

// Live worker registry — inherently process-local because it holds open SSE
// response objects (see the multi-instance caveat in store.js).
const workers = new Map(); // workerId -> { res, categories: Set<string>, connectedAt }

// Per-question quorum collector, also process-local for the same reason.
// `quorumSize` is the CURRENT target and is mutable: fixed-quorum questions
// never change it, escalating ones (see dispatchEscalating) grow it mid-flight.
// `escalation`, present only on escalating questions, holds the extra state
// for that mode; fixed-quorum collectors leave it undefined.
const collectors = new Map(); // questionId -> { submissions: Map<workerId, answer>, quorumSize, finished, finish, escalation? }

const REPUTATION_PREFIX = 'rep:';
// A single durable list of every workerId that has ever had an outcome
// recorded — reputation itself is keyed per-worker (rep:{workerId}), which
// is fine for a single lookup but can't be enumerated. This index is what
// makes a public leaderboard possible without scanning the whole store.
// Bounded and de-duplicated the same way payerIndex.js bounds its per-payer
// list, for the same reason: durable, unbounded growth is the failure mode
// to avoid, not a real capacity concern at this scale.
const WORKER_INDEX_KEY = 'known-worker-ids';
const MAX_TRACKED_WORKERS = 5_000;

export function onlineWorkerCount() {
  return workers.size;
}

function normalizeCategory(category) {
  return String(category).trim().toLowerCase();
}

/**
 * Anti-sybil guard #1: rate-limit how many SSE connections a single IP can
 * open per window. Doesn't stop a determined attacker with many IPs, but
 * kills the trivial "open 500 tabs" version of quorum-stuffing.
 */
export async function checkConnectionRateLimit(ip) {
  return checkRateLimit(`sse:${ip}`, config.worker.rateLimitMaxConnections, config.worker.rateLimitWindowMs);
}

export function registerWorker(workerId, res, categories = []) {
  workers.set(workerId, { res, categories: new Set(categories.map(normalizeCategory)), connectedAt: Date.now() });
}

export function unregisterWorker(workerId) {
  workers.delete(workerId);
}

/**
 * Anti-sybil guard #2: worker reputation. Once a worker has answered enough
 * questions to have a meaningful sample, one whose answers rarely match
 * consensus is quietly excluded from future routing (not banned outright —
 * new workers always get a fair first run, and this never blocks a worker
 * from receiving broadcasts when the fallback-to-everyone path kicks in).
 */
export async function getReputation(workerId) {
  return (await store.get(REPUTATION_PREFIX + workerId)) || { matched: 0, total: 0 };
}

export async function recordOutcome(workerId, matched) {
  const key = REPUTATION_PREFIX + workerId;
  const rec = (await store.get(key)) || { matched: 0, total: 0 };
  const isNew = rec.total === 0;
  rec.total += 1;
  if (matched) rec.matched += 1;
  await store.set(key, rec); // no TTL — reputation is durable

  if (isNew) {
    const known = (await store.get(WORKER_INDEX_KEY)) || [];
    if (!known.includes(workerId)) {
      await store.set(WORKER_INDEX_KEY, [workerId, ...known].slice(0, MAX_TRACKED_WORKERS));
    }
  }
}

export async function getKnownWorkerIds() {
  return (await store.get(WORKER_INDEX_KEY)) || [];
}

// Periodically-refreshed cache of established workers' on-chain stake — see
// setCachedStake() below. Same "sample on an interval, tolerate staleness"
// trade-off already made for worker supply (see supplySamplerHandle).
// WORKER_MIN_STAKE_STROOPS defaults to 0, which disables this check
// entirely (today's behavior) — it's an opt-in, not a silent policy change.
const stakeCache = new Map(); // workerId -> stroops (bigint)

/** Pure decision logic, factored out so it's directly testable with any
 * threshold — config is frozen at load time (Object.freeze), so a test in
 * this same process can't exercise a non-default minStakeStroops by
 * mutating config. Mirrors computeSmoothedCount's reason for existing as
 * its own pure function below. Fails open (true) when minStakeStroops is
 * 0/disabled, or when there's no cached stake yet — routing quality is a
 * soft preference, payment settlement is not, same principle
 * selectTargets() already documents for reputation gating. */
export function stakeGateAllows(cachedStake, minStakeStroops) {
  if (minStakeStroops <= 0n) return true;
  if (cachedStake === undefined) return true;
  return cachedStake >= minStakeStroops;
}

async function isEligible(workerId) {
  const rep = await getReputation(workerId);
  if (rep.total < config.worker.minAnswersBeforeReputationGate) return true;
  if (rep.matched / rep.total < config.worker.minMatchRatio) return false;
  return stakeGateAllows(stakeCache.get(workerId), config.worker.minStakeStroops);
}

/**
 * Whether a worker has enough history to be a known quantity at all — a
 * fresh (possibly sybil) identity always reads false here, regardless of
 * its (nonexistent) match ratio. This is a stricter question than
 * isEligible(): a brand-new worker IS eligible for routing (fair first run)
 * but is NOT established, and reconcile.js's fast path uses this distinction
 * to require Claude review whenever a unanimous quorum contains any
 * unestablished worker — see reconcile.js for why.
 */
export async function isEstablishedWorker(workerId) {
  const rep = await getReputation(workerId);
  return rep.total >= config.worker.minAnswersBeforeReputationGate;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * `preferEstablished` is what ties the pricing tiers to the public
 * leaderboard (see leaderboard.js) instead of leaving them as parallel,
 * unrelated features — the Priority tier's whole premise is "route to the
 * verifiers with a real track record first," so it should actually mean
 * that, not just "a bigger quorum." Still fails open: never lets the
 * established-only pool drop below quorumSize's worth of recipients, since
 * a starved quorum is a worse outcome than one with a fresh worker in it.
 */
async function selectTargets(category, { preferEstablished = false, quorumSize = 0 } = {}) {
  let targets = [...workers.entries()];

  if (category) {
    const norm = normalizeCategory(category);
    // Generalists (no declared categories) always receive everything;
    // specialists only receive their declared categories.
    const matching = targets.filter(([, w]) => w.categories.size === 0 || w.categories.has(norm));
    // Fail open on routing: if nobody in this category is online, broadcast
    // to everyone rather than stranding the question with zero recipients.
    if (matching.length > 0) targets = matching;
  }

  const eligible = [];
  for (const entry of targets) {
    if (await isEligible(entry[0])) eligible.push(entry);
  }
  // Reputation gating must never be able to zero out the recipient list —
  // routing quality is a soft preference, payment settlement is not.
  const pool = eligible.length > 0 ? eligible : targets;
  if (!preferEstablished) return pool;

  const established = [];
  for (const entry of pool) {
    if (await isEstablishedWorker(entry[0])) established.push(entry);
  }
  return established.length >= quorumSize ? established : pool;
}

/**
 * `limit` / `exclude` exist for escalating dispatch: recruit only `limit`
 * workers (established ones first — the confidence signal for a lone answer
 * is the worker's track record, so ask the best-known worker first), and
 * skip anyone in `exclude` (already asked in an earlier round). Both default
 * to today's broadcast-to-everyone behavior. A limited broadcast also skips
 * the offline push fan-out: notifying every offline worker would defeat
 * the point of starting with a small pool.
 */
export async function broadcast(questionId, questionText, { category, quorumSize, expiresInMs, preferEstablished, limit, exclude } = {}) {
  const payload = { questionId: questionId.toString(), question: questionText, quorumSize, expiresInMs };
  let targets = await selectTargets(category, { preferEstablished, quorumSize });
  if (exclude) targets = targets.filter(([id]) => !exclude.has(id));
  if (limit !== undefined) {
    const ranked = await Promise.all(targets.map(async (entry) => ({ entry, established: await isEstablishedWorker(entry[0]) })));
    ranked.sort((a, b) => Number(b.established) - Number(a.established)); // stable: keeps connection order within a group
    targets = ranked.slice(0, limit).map((r) => r.entry);
  }
  for (const [, w] of targets) writeSse(w.res, 'question', payload);

  // Supplement SSE with push notifications for workers who are eligible
  // but not currently connected — only when the timeout window realistically
  // allows time to notice, tap, and load before the quorum closes (see
  // push.js for the honest tradeoff; short-timeout tiers skip this).
  if (limit === undefined && expiresInMs >= config.push.minTimeoutForPushMs) {
    const onlineIds = new Set(targets.map(([id]) => id));
    const offlineEligible = getPushEligibleWorkerIds(category).filter((id) => !onlineIds.has(id));
    for (const workerId of offlineEligible) {
      notifyWorker(workerId, {
        title: 'New question on Arbiter',
        body: questionText.length > 120 ? `${questionText.slice(0, 117)}...` : questionText,
        questionId: questionId.toString(),
      }).catch(() => {});
    }
  }

  return targets.map(([id]) => id);
}

/**
 * Trailing-average worker supply, sampled every SUPPLY_SAMPLE_INTERVAL_MS
 * over a SUPPLY_WINDOW_SAMPLES window (~60s). Used for surge pricing
 * instead of the instantaneous onlineWorkerCount(): connecting/
 * disconnecting an SSE stream is free and instant, so pricing off the raw
 * count rewards a worker cartel that briefly disconnects right before a
 * question is asked (spiking the multiplier) and reconnects in time to
 * answer and split the now-inflated pool. Averaging over a real trailing
 * window forces that cartel to actually sit out genuine dispatch
 * opportunities for a meaningful stretch to move the price — real cost,
 * not a free instant toggle. This raises the bar; it does not eliminate
 * the incentive entirely.
 */
const SUPPLY_SAMPLE_INTERVAL_MS = 5_000;
const SUPPLY_WINDOW_SAMPLES = 12;
const supplySamples = [];

const supplySamplerHandle = setInterval(() => {
  supplySamples.push(workers.size);
  if (supplySamples.length > SUPPLY_WINDOW_SAMPLES) supplySamples.shift();
}, SUPPLY_SAMPLE_INTERVAL_MS);
supplySamplerHandle.unref?.();

const STAKE_SAMPLE_INTERVAL_MS = 30_000;

/** Refreshes stakeCache for every currently-online established worker, and
 * drops cache entries for anyone no longer online (bounded growth). Skips
 * entirely when the feature is disabled (minStakeStroops <= 0) so a default
 * deployment never pays for RPC calls it doesn't need. A failed lookup for
 * one worker just leaves their previous cached value in place — isEligible
 * fails open on a genuinely missing entry, never on a stale-but-present one. */
async function refreshStakeCache() {
  if (config.worker.minStakeStroops <= 0n) return;

  const onlineIds = new Set(workers.keys());
  for (const cachedId of stakeCache.keys()) {
    if (!onlineIds.has(cachedId)) stakeCache.delete(cachedId);
  }

  await Promise.all(
    [...onlineIds].map(async (workerId) => {
      const rep = await getReputation(workerId);
      if (rep.total < config.worker.minAnswersBeforeReputationGate) return;
      try {
        stakeCache.set(workerId, await getStakeOnChain(workerId));
      } catch {
        // leave whatever was cached before, if anything.
      }
    }),
  );
}

const stakeSamplerHandle = setInterval(() => {
  refreshStakeCache().catch(() => {});
}, STAKE_SAMPLE_INTERVAL_MS);
stakeSamplerHandle.unref?.();

// Storage TTL only extends on a write that touches an entry (see
// touch()/credit_owed()/stake() in lib.rs) — a worker who earns once and
// never comes back to stake or withdraw again would otherwise have their
// Owed/Stake entries silently archive off-chain storage. Sweeping once a
// day is enormously conservative against the ~5.8-day (100_000-ledger)
// renewal threshold the contract itself uses, while still keeping the
// platform's per-touch() network fee bill low. Skipped entirely when no
// admin key is configured (e.g. most test/dev runs) — same "don't pay for
// what isn't wired up" principle as refreshStakeCache's early return.
const TTL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function sweepWorkerTtls() {
  if (!config.platformSecret) return;

  const knownIds = await getKnownWorkerIds();
  await Promise.all(
    knownIds.map(async (workerId) => {
      try {
        await touchWorker(workerId);
      } catch (err) {
        logger.warn({ err, workerId }, 'touch() TTL sweep failed for worker');
      }
    }),
  );
}

const ttlSweepHandle = setInterval(() => {
  sweepWorkerTtls().catch(() => {});
}, TTL_SWEEP_INTERVAL_MS);
ttlSweepHandle.unref?.();

/** Pure averaging math, factored out so it's testable without waiting on
 * real timers. Falls back to the live count when no samples exist yet
 * (e.g. right after process start). */
export function computeSmoothedCount(samples, currentCount) {
  if (samples.length === 0) return currentCount;
  const sum = samples.reduce((a, b) => a + b, 0);
  return Math.round(sum / samples.length);
}

export function getSmoothedOnlineWorkerCount() {
  return computeSmoothedCount(supplySamples, workers.size);
}

/**
 * Always resolves, never rejects, with whatever submissions arrived —
 * reconciliation downstream must never hang or throw just because dispatch
 * had a bad day. Each submission is annotated with `established` (see
 * isEstablishedWorker) so reconcile.js can decide whether a unanimous
 * result is trustworthy enough to fast-path.
 */
export function dispatchAndCollect(questionId, questionText, { quorumSize, timeoutMs, category, preferEstablished } = {}) {
  const qid = questionId.toString();
  return new Promise((resolvePromise) => {
    const state = { submissions: new Map(), quorumSize, finished: false };
    collectors.set(qid, state);

    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      collectors.delete(qid);
      const raw = [...state.submissions.entries()].map(([workerId, answer]) => ({ workerId, answer }));
      annotateEstablished(raw)
        .then(resolvePromise)
        .catch(() => resolvePromise(raw.map((s) => ({ ...s, established: false }))));
    }
    state.finish = finish;

    broadcast(questionId, questionText, { category, quorumSize, expiresInMs: timeoutMs, preferEstablished }).catch((err) => {
      jobLogger(questionId).error({ err }, 'broadcast failed');
    });
  });
}

async function annotateEstablished(submissions) {
  return Promise.all(submissions.map(async (s) => ({ ...s, established: await isEstablishedWorker(s.workerId) })));
}

/** Returns false (never throws) if the question is closed/expired or this worker already answered it. */
export function submitAnswer(questionId, workerId, answer) {
  const state = collectors.get(questionId.toString());
  if (!state || state.finished) return false;
  if (state.submissions.has(workerId)) return false;
  state.submissions.set(workerId, answer);
  if (state.escalation) {
    state.escalation.onSubmission();
  } else if (state.submissions.size >= state.quorumSize) {
    state.finish();
  }
  return true;
}

/**
 * Pure escalate-vs-settle decision, factored out (like computeSmoothedCount
 * and stakeGateAllows) so the branching is testable without timers or SSE.
 *
 *   submissionCount  answers received so far
 *   targetSize       how many workers we're currently waiting on
 *   maxQuorum        hard cap on recruits
 *   singleConfidence confidence in a LONE answer (see singleAnswerConfidence)
 *   threshold        singleConfidence needed to settle on one answer
 *   allAgree         whether every answer so far normalizes identically
 *
 * Returns { action: 'wait' } | { action: 'settle', reason } |
 * { action: 'escalate', newTarget }. Recruit growth is 1 -> 3 -> 5 (2n+1,
 * capped): from one unconfident answer straight to an odd, majority-capable
 * quorum, rather than a pair that can only tie.
 */
export function decideEscalation({ submissionCount, targetSize, maxQuorum, singleConfidence, threshold, allAgree }) {
  if (submissionCount <= 0) return { action: 'wait' };
  if (submissionCount >= maxQuorum) return { action: 'settle', reason: 'max-quorum' };

  if (submissionCount === 1) {
    if (singleConfidence >= threshold) return { action: 'settle', reason: 'confident-single-answer' };
    return targetSize <= 1 ? { action: 'escalate', newTarget: Math.min(maxQuorum, targetSize * 2 + 1) } : { action: 'wait' };
  }

  if (submissionCount < targetSize) return { action: 'wait' };
  if (allAgree) return { action: 'settle', reason: 'quorum-agreement' };
  if (targetSize < maxQuorum) return { action: 'escalate', newTarget: Math.min(maxQuorum, targetSize * 2 + 1) };
  return { action: 'settle', reason: 'max-quorum' };
}

/**
 * The confidence signal for a lone worker answer: the worker's own
 * track record, as a Laplace-smoothed consensus-match ratio,
 * (matched + 1) / (total + 2), and 0 for anyone not yet established.
 *
 * Why this and not a vote or an LLM check: with one submission there is
 * nothing to vote against, so agreement can't be measured. An LLM
 * plausibility call (reconcileWithClaude-style) would add latency and cost to
 * the exact path meant to be cheap, and it can't see who answered — a fresh
 * sybil identity would score the same as a proven verifier. Reputation is
 * already the signal this codebase trusts for the unanimous fast path
 * (reconcile.js requires isEstablishedWorker), it is free (one store read),
 * and it is costly to fake, since matches only accrue by agreeing with
 * consensus over many real questions. Smoothing stops a 5-for-5 newcomer from
 * reading as 100% sure: it takes ~4+ established matches without a miss to
 * clear the default 0.8 threshold, and any misses pull it back under.
 */
export function singleAnswerConfidence(rep, minAnswersBeforeEstablished) {
  if (rep.total < minAnswersBeforeEstablished) return 0;
  return (rep.matched + 1) / (rep.total + 2);
}

/**
 * Escalating dispatch: recruits `initialQuorum` workers, then either settles
 * on what came back or grows the target (up to `maxQuorum`) and recruits
 * more, re-evaluating on every submission. Reuses the same `collectors`
 * state and submitAnswer() path as dispatchAndCollect — the only differences
 * are that `quorumSize` is mutable and submitAnswer() delegates the "are we
 * done?" question to decideEscalation instead of a fixed size check.
 *
 * Like dispatchAndCollect it always resolves, never rejects. Resolves with
 * { submissions, recruitedWorkers, finalQuorumSize, settledBy, confidence }
 * where `recruitedWorkers` is how many distinct workers were actually asked
 * (may be fewer than the target if not enough are online) and `confidence`
 * is the lone-answer confidence when exactly one answer was used (else null).
 */
export function dispatchEscalating(
  questionId,
  questionText,
  { timeoutMs, category, escalation, minAnswers = config.worker.minAnswersBeforeReputationGate } = {},
) {
  const qid = questionId.toString();
  const { initialQuorum, maxQuorum, confidenceThreshold, stepTimeoutMs } = escalation;

  return new Promise((resolvePromise) => {
    const asked = new Set();
    let stepTimer = null;
    let evalChain = Promise.resolve();
    let settledBy = 'timeout';
    let lastConfidence = null;

    const state = { submissions: new Map(), quorumSize: initialQuorum, finished: false };
    collectors.set(qid, state);

    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      clearTimeout(stepTimer);
      collectors.delete(qid);
      const raw = [...state.submissions.entries()].map(([workerId, answer]) => ({ workerId, answer }));
      const done = (submissions) =>
        resolvePromise({
          submissions,
          recruitedWorkers: asked.size,
          finalQuorumSize: state.quorumSize,
          settledBy,
          confidence: submissions.length === 1 ? lastConfidence : null,
        });
      annotateEstablished(raw)
        .then(done)
        .catch(() => done(raw.map((s) => ({ ...s, established: false }))));
    }
    state.finish = finish;

    async function recruit(count) {
      const ids = await broadcast(questionId, questionText, {
        category,
        quorumSize: state.quorumSize,
        expiresInMs: timeoutMs,
        preferEstablished: true,
        limit: count,
        exclude: asked,
      });
      for (const id of ids) asked.add(id);
      armStepTimer();
    }

    // If the current recruits go quiet, don't sit on a target that may
    // never fill — widen the pool. Only ever grows, and stops at the cap.
    function armStepTimer() {
      clearTimeout(stepTimer);
      if (state.finished || state.quorumSize >= maxQuorum) return;
      stepTimer = setTimeout(() => {
        if (state.finished) return;
        grow(Math.min(maxQuorum, state.quorumSize * 2 + 1));
      }, stepTimeoutMs);
      stepTimer.unref?.();
    }

    function grow(newTarget) {
      const extra = newTarget - state.quorumSize;
      state.quorumSize = newTarget;
      recruit(extra).catch((err) => jobLogger(questionId).error({ err }, 'escalation broadcast failed'));
    }

    async function evaluate() {
      if (state.finished) return;
      const answers = [...state.submissions.entries()].map(([workerId, answer]) => ({ workerId, answer }));
      let singleConfidence = 0;
      if (answers.length === 1) {
        singleConfidence = singleAnswerConfidence(await getReputation(answers[0].workerId), minAnswers);
        lastConfidence = singleConfidence;
      }
      if (state.finished) return;
      const decision = decideEscalation({
        submissionCount: answers.length,
        targetSize: state.quorumSize,
        maxQuorum,
        singleConfidence,
        threshold: confidenceThreshold,
        allAgree: answers.length > 1 && exactMatchVote(answers).allAgree,
      });
      if (decision.action === 'settle') {
        settledBy = decision.reason;
        finish();
      } else if (decision.action === 'escalate') {
        grow(decision.newTarget);
      }
    }

    state.escalation = {
      // Serialized so two near-simultaneous submissions can't both decide
      // to grow the target from the same starting size.
      onSubmission() {
        evalChain = evalChain.then(evaluate).catch((err) => jobLogger(questionId).error({ err }, 'escalation evaluation failed'));
      },
    };

    recruit(initialQuorum).catch((err) => {
      jobLogger(questionId).error({ err }, 'broadcast failed');
    });
  });
}

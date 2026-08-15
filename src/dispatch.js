import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { jobLogger } from './logger.js';

// Live worker registry — inherently process-local because it holds open SSE
// response objects (see the multi-instance caveat in store.js).
const workers = new Map(); // workerId -> { res, categories: Set<string>, connectedAt }

// Per-question quorum collector, also process-local for the same reason.
const collectors = new Map(); // questionId -> { submissions: Map<workerId, answer>, quorumSize, finished, finish }

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

async function isEligible(workerId) {
  const rep = await getReputation(workerId);
  if (rep.total < config.worker.minAnswersBeforeReputationGate) return true;
  return rep.matched / rep.total >= config.worker.minMatchRatio;
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

export async function broadcast(questionId, questionText, { category, quorumSize, expiresInMs, preferEstablished } = {}) {
  const payload = { questionId: questionId.toString(), question: questionText, quorumSize, expiresInMs };
  const targets = await selectTargets(category, { preferEstablished, quorumSize });
  for (const [, w] of targets) writeSse(w.res, 'question', payload);

  // Supplement SSE with push notifications for workers who are eligible
  // but not currently connected — only when the timeout window realistically
  // allows time to notice, tap, and load before the quorum closes (see
  // push.js for the honest tradeoff; short-timeout tiers skip this).
  if (expiresInMs >= config.push.minTimeoutForPushMs) {
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
  if (state.submissions.size >= state.quorumSize) state.finish();
  return true;
}

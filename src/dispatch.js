import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { getStakeOnChain, touchWorker } from './stellarClient.js';
import { jobLogger, logger } from './logger.js';

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

/*
 * ---------------------------------------------------------------------------
 * THREAT MODEL: dispatch-fairness attacks (coordinated bot-cartel starvation)
 * ---------------------------------------------------------------------------
 *
 * The dispatch path is a first-come-first-served race: broadcast() fans a
 * question out over SSE and the first `quorumSize` answers to arrive win the
 * reward. That design is inherently gameable by whoever has the lowest
 * latency, and the cheapest way to buy latency is infrastructure, not
 * competence:
 *
 *   T1. Instant-response cartel. N bot workers sit on the SSE stream and
 *       answer within milliseconds of every broadcast. Because they always
 *       win the race, honest (slower, human) workers never reach quorum and
 *       never earn, so they churn out — the cartel's share of answered
 *       questions trends toward 100% and the honest supply it depends on
 *       collapses. This is the primary attack this file defends against.
 *
 *   T2. Established-identity laundering. `preferEstablished` (Priority tier)
 *       narrows the pool to workers with a real track record, but a cartel
 *       that has already farmed reputation on throwaway identities is
 *       "established" too, so the preference alone does not exclude it.
 *       Mitigation must therefore not rely on reputation as the sole gate.
 *
 *   T3. Sybil fan-out. One operator opens many connections to multiply its
 *       odds of being first. Partially covered by the per-IP connection rate
 *       limit (checkConnectionRateLimit) and the reputation gate
 *       (isEligible), but neither removes the latency advantage of a single
 *       fast identity.
 *
 *   T4. Quorum stuffing. A cartel that controls >= quorumSize identities can
 *       answer a question entirely on its own and dictate consensus. The
 *       reputation gate and the unestablished-worker review path in
 *       reconcile.js raise the cost of this, but the race itself is the
 *       enabling condition.
 *
 * Design conclusion: any purely first-come-first-served selection is
 * gameable by faster infrastructure, so the fix cannot be "answer faster" or
 * "rate limit harder" — it must remove the *reward for being first*. The
 * mechanism below does exactly that: answers that arrive inside a short
 * selection window are treated as simultaneous and the winners are chosen at
 * random (reputation-weighted), so an instant-response bot gains no
 * advantage over an honest worker that answers a few hundred milliseconds
 * later. See selectWinners() and the accompanying simulation in
 * test/dispatchFairness.test.js.
 * ---------------------------------------------------------------------------
 */

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

/*
 * ---------------------------------------------------------------------------
 * MITIGATION: randomized selection among early responders
 * ---------------------------------------------------------------------------
 *
 * The race is removed by treating every answer that lands inside a short
 * selection window as simultaneous, then choosing the quorum's winners at
 * random instead of by arrival order. Concretely:
 *
 *   - When a question opens, we record its open time and start a window of
 *     `config.worker.selectionWindowMs` (default 400ms).
 *   - Answers arriving inside the window are buffered, not accepted.
 *   - When the window closes (or the buffer already holds >= quorumSize
 *     answers), we pick `quorumSize` winners from the buffer using a
 *     reputation-weighted random draw: a worker's weight is
 *     `1 + matched` (so a proven worker is modestly favored) but every
 *     worker — including a brand-new one — has a nonzero chance. This is
 *     what makes instant response unprofitable: a bot that answers in 5ms
 *     and an honest worker that answers in 300ms are in the same draw, so
 *     the bot's expected share is bounded by its share of the pool, not by
 *     its latency.
 *   - Answers arriving after the window closes are handled by the existing
 *     first-come path, so a slow-but-honest worker is never worse off than
 *     today when the window is empty.
 *
 * The window is deliberately short: it must be long enough to cover normal
 * network jitter (so honest workers are not excluded) and short enough that
 * it does not meaningfully delay quorum for the common case. 400ms is the
 * default and is configurable via WORKER_SELECTION_WINDOW_MS.
 *
 * This is a *selection* mechanism, not rate limiting: it changes who wins a
 * question, not how often anyone may answer. It composes with the existing
 * reputation gate (isEligible) and the Priority-tier preference
 * (preferEstablished) rather than replacing them.
 * ---------------------------------------------------------------------------
 */

/**
 * Pure, deterministic-given-rng selection of `quorumSize` winners from a
 * list of `{ workerId, weight }` candidates. Factored out (like
 * stakeGateAllows and computeSmoothedCount) so the fairness property can be
 * tested directly without a live SSE stream. Uses weighted sampling without
 * replacement: each pick removes the chosen candidate and re-normalizes, so
 * a worker can never be selected twice for the same question.
 *
 * `rng` defaults to Math.random and is injectable so tests can drive the
 * draw deterministically.
 */
export function selectWinners(candidates, quorumSize, rng = Math.random) {
  const pool = candidates.map((c) => ({ ...c }));
  const winners = [];
  const n = Math.min(quorumSize, pool.length);
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (const c of pool) total += c.weight;
    if (total <= 0) break;
    let r = rng() * total;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) {
        idx = j;
        break;
      }
    }
    winners.push(pool[idx].workerId);
    pool.splice(idx, 1);
  }
  return winners;
}

/** Reputation-weighted candidate weight: proven workers are modestly favored
 * but a fresh identity still has a real chance, so the draw can't be farmed
 * by reputation alone (threat T2). */
export function candidateWeight(rep) {
  return 1 + (rep && rep.matched ? rep.matched : 0);
}

export async function broadcast(questionId, questionText, { category, quorumSize, expiresInMs, preferEstablished } = {}) {
  const payload = { questionId: questionId.toString(), question: questionText, quorumSize, expiresInMs };
  const targets = await selectTargets(category, { preferEstablished, quorumSize });
  for (const [, w] of targets) writeSse(w.res, 'question', payload);

  // Supplement SSE with push notifications for workers who are eligible
  // but not currently connected — only when the timeout window realistically
  // allows time to notice, tap, and load before the quorum closes (see
  // push.js for the honest tradeoff; short-timeout tiers skip this).
  if (expiresInMs >
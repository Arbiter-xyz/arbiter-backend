import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { screenAnswer } from './answerFilter.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { getStakeOnChain, touchWorker } from './stellarClient.js';
import { jobLogger, logger } from './logger.js';
import { isCollusionSuspended } from './collusion.js';
import { recordWorkerActivity } from './workerAnalytics.js';
import { syncBadges } from './gamification.js';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// Live worker registry — inherently process-local because it holds open SSE
// response objects (see the multi-instance caveat in store.js).
const workers = new Map(); // workerId -> { res, categories: Set<string>, connectedAt }

// Shared presence registry — the *fact* that a worker is online (id,
// categories, connected-at) lives in the Redis-backed store so every backend
// instance sees the whole fleet, while the SSE `res` object above stays
// process-local. Presence entries carry a short TTL refreshed on the existing
// SSE keep-alive heartbeat, so a crashed instance's workers expire on their
// own without a graceful disconnect. When REDIS_URL is unset, MemoryStore's
// single-process semantics keep this behaving exactly as before.
const PRESENCE_PREFIX = 'presence:';
const PRESENCE_TTL_SECONDS = 60;

// Per-question quorum collector, also process-local for the same reason.
// `quorumSize` is the CURRENT target and is mutable: fixed-quorum questions
// never change it, escalating ones (see dispatchEscalating) grow it mid-flight.
// `escalation`, present only on escalating questions, holds the extra state
// for that mode; fixed-quorum collectors leave it undefined.
const collectors = new Map(); // questionId -> { submissions: Map<workerId, answer>, quorumSize, finished, finish, escalation? }

// Cross-instance answer routing (issue #160).
//
// The collector/quorum state machine above stays in-memory on whichever
// instance dispatched the question — only the *routing* of an answer to the
// owning collector crosses the instance boundary. We use Redis pub/sub
// (rather than Streams) because answers are fire-and-forget: a late answer
// for an already-settled question is simply dropped, so we don't need the
// replay/ordering guarantees Streams would buy us, and pub/sub keeps the
// transport to a single subscribe/publish pair with no consumer-group
// bookkeeping. The channel is keyed by questionId, so the owning instance
// subscribes to exactly the questions it dispatched.
const ANSWER_CHANNEL_PREFIX = 'quorum:answer:';

function answerChannel(questionId) {
  return ANSWER_CHANNEL_PREFIX + questionId;
}

// questionId -> unsubscribe handle for the pub/sub subscription owned by
// this instance. Kept alongside `collectors` so the subscription is torn
// down at the same moment the collector is.
const answerSubscriptions = new Map();

/**
 * Subscribe this instance to the answer channel for a question it owns.
 * Called when a collector is created. No-op (and no new failure mode) when
 * the store has no pub/sub support — single-instance deployments keep
 * working exactly as before.
 */
async function subscribeToAnswers(questionId) {
  if (typeof store.subscribe !== 'function') return;
  if (answerSubscriptions.has(questionId)) return;
  try {
    const unsubscribe = await store.subscribe(answerChannel(questionId), (payload) => {
      // Answers arriving over the wire are routed through the same local
      // path as answers submitted directly to this instance, so quorum
      // accounting is identical regardless of which instance received them.
      handleAnswer(payload.questionId, payload.workerId, payload.answer, payload.traceparent);
    });
    answerSubscriptions.set(questionId, unsubscribe);
  } catch (err) {
    logger.warn({ err, questionId }, 'failed to subscribe to cross-instance answer channel');
  }
}

function unsubscribeFromAnswers(questionId) {
  const unsubscribe = answerSubscriptions.get(questionId);
  if (!unsubscribe) return;
  answerSubscriptions.delete(questionId);
  try {
    unsubscribe();
  } catch (err) {
    logger.warn({ err, questionId }, 'failed to unsubscribe from cross-instance answer channel');
  }
}

/**
 * Publish an answer to the channel owned by whichever instance holds the
 * collector. Used when this instance receives an answer for a question it
 * does not own (no local collector). Best-effort: if publishing fails the
 * answer is dropped, which is the same outcome as today's behavior for an
 * answer that lands on the wrong instance.
 */
async function publishAnswer(questionId, workerId, answer, traceparent) {
  if (typeof store.publish !== 'function') return;
  try {
    await store.publish(answerChannel(questionId), { questionId, workerId, answer, traceparent });
  } catch (err) {
    logger.warn({ err, questionId, workerId }, 'failed to publish cross-instance answer');
  }
}

/**
 * Entry point for an answer submission. If this instance owns the
 * collector, record it locally; otherwise forward it to the owning
 * instance over pub/sub. This is the single routing decision that makes
 * cross-instance quorum collection work.
 */
export function submitAnswer(questionId, workerId, answer, traceparent) {
  if (collectors.has(questionId)) {
    return handleAnswer(questionId, workerId, answer, traceparent);
  }
  if (typeof store.publish !== 'function') return false;
  publishAnswer(questionId, workerId, answer, traceparent);
  return true;
}

/**
 * Record an answer against the local collector for `questionId`, inside the
 * question's trace context so the answer span is correlated with the
 * original HTTP request and the on-chain settlement that follows. Shared by
 * the direct-submission path and the pub/sub delivery path so both count
 * toward quorum identically. Returns false when there is no local collector
 * (e.g. the owning instance died and this is a stale delivery), when the
 * worker already answered, or when content screening rejects the answer —
 * a filtered answer must never count toward quorum.
 */
function handleAnswer(questionId, workerId, answer, traceparent) {
  const parentCtx = contextFromTraceparent(traceparent);
  return context.with(parentCtx, () => {
    const span = tracer().startSpan('dispatch.answer', {
      kind: SpanKind.CONSUMER,
      attributes: {
        'question.id': questionId.toString(),
        'worker.id': workerId,
      },
    });
    try {
      const collector = collectors.get(questionId);
      if (!collector || collector.finished) {
        span.setAttribute('dispatch.answer_accepted', false);
        return false;
      }
      if (collector.submissions.has(workerId)) {
        span.setAttribute('dispatch.answer_accepted', false);
        span.setAttribute('dispatch.answer_duplicate', true);
        return false;
      }
      // Private pools fail closed: a worker who learns a private question's id
      // out of band still can't answer unless they were dispatched to.
      if (collector.whitelist && !collector.whitelist.has(workerId)) {
        span.setAttribute('dispatch.answer_accepted', false);
        span.setAttribute('dispatch.answer_not_whitelisted', true);
        return false;
      }
      const screened = screenAnswer(answer);
      if (!screened.ok) {
        span.setAttribute('dispatch.answer_accepted', false);
        span.setAttribute('dispatch.answer_filtered', screened.reason);
        return false;
      }
      collector.submissions.set(workerId, answer);
      span.setAttribute('dispatch.answer_accepted', true);
      span.setAttribute('dispatch.submissions', collector.submissions.size);
      if (collector.submissions.size >= collector.quorumSize) {
        collector.finished = true;
        unsubscribeFromAnswers(questionId);
        const settled = collector.finish(collector.submissions);
        if (settled?.catch) settled.catch((err) => jobLogger(questionId).error({ err }, 'quorum finish failed'));
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return true;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

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

// Distributed tracing: the trace ID is generated once at question-creation
// time (see jobs.js) and threaded through every subsequent system boundary —
// the backend job pipeline, SSE dispatch to workers, and the on-chain Soroban
// settlement transaction — so a single trace ID reconstructs the whole
// lifecycle. The traceparent is carried in the SSE payload and echoed back on
// worker answers, letting the collector re-enter the same trace context.
const TRACER_NAME = 'handsoff.dispatch';

function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Extract a W3C traceparent (or any configured propagator carrier) into an
 * OpenTelemetry context. Returns the active context when no carrier is
 * present so callers can always run inside *some* context.
 */
export function contextFromTraceparent(traceparent) {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}

/**
 * Serialize the currently-active span's context into a W3C traceparent so it
 * can cross a boundary that has no native tracing concept — an SSE frame, a
 * durable job record, or a Soroban transaction memo. This is the single
 * primitive that makes the on-chain transaction part of the same trace.
 */
export function currentTraceparent() {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

function presenceKey(workerId) {
  return PRESENCE_PREFIX + workerId;
}

/**
 * Read the shared presence set. Returns a Map of workerId -> presence record
 * ({ categories: string[], connectedAt: number }) covering every instance's
 * connected workers. Falls back to the local `workers` Map when the store has
 * no Redis client (MemoryStore), preserving today's single-process behavior.
 */
async function readPresence() {
  const client = store.getClient && store.getClient();
  if (!client) {
    const local = new Map();
    for (const [workerId, w] of workers) {
      local.set(workerId, { categories: [...w.categories], connectedAt: w.connectedAt });
    }
    return local;
  }
  const raw = await client.hgetall(PRESENCE_PREFIX + 'workers');
  const presence = new Map();
  for (const [workerId, json] of Object.entries(raw || {})) {
    try {
      presence.set(workerId, JSON.parse(json));
    } catch {
      // Ignore malformed entries rather than failing the whole read.
    }
  }
  return presence;
}

export async function onlineWorkerCount() {
  return (await readPresence()).size;
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

export async function registerWorker(workerId, res, categories = []) {
  const normalized = categories.map(normalizeCategory);
  workers.set(workerId, { res, categories: new Set(normalized), connectedAt: Date.now() });
  await writePresence(workerId, normalized);
}

/**
 * Write (or refresh) a worker's shared presence entry with a short TTL. Called
 * on connect and on every SSE keep-alive heartbeat, so a crashed instance's
 * workers expire automatically instead of lingering forever.
 */
export async function writePresence(workerId, categories) {
  const client = store.getClient && store.getClient();
  if (!client) return;
  const record = JSON.stringify({ categories, connectedAt: Date.now() });
  await client.hset(PRESENCE_PREFIX + 'workers', workerId, record);
  if (client.expire) await client.expire(presenceKey(workerId), PRESENCE_TTL_SECONDS);
}

/**
 * Refresh presence for a worker on the existing keep-alive heartbeat. No-op
 * when the worker isn't locally registered (e.g. already disconnected).
 */
export async function refreshPresence(workerId) {
  const w = workers.get(workerId);
  if (!w) return;
  await writePresence(workerId, [...w.categories]);
}

export async function unregisterWorker(workerId) {
  workers.delete(workerId);
  const client = store.getClient && store.getClient();
  if (!client) return;
  await client.hdel(PRESENCE_PREFIX + 'workers', workerId);
  if (client.del) await client.del(presenceKey(workerId));
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

  // Analytics + gamification are observability only — a failure here must
  // never fail settlement, so it's logged and swallowed.
  try {
    await recordWorkerActivity(workerId, matched);
    const newlyEarned = await syncBadges(workerId);
    if (newlyEarned.length > 0) logger.info({ workerId, badges: newlyEarned }, 'worker earned badges');
  } catch (err) {
    logger.warn({ err, workerId }, 'failed to record worker analytics');
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
  // A worker suspended by collusion.js's heuristics sits out routing until
  // an operator reviews the pair. Like every gate here it fails open —
  // selectTargets() never lets eligibility zero out the recipient list.
  if (await isCollusionSuspended(workerId)) return false;
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

/**
 * Pure heuristic deciding whether a known workerId is worth a `touch()` call
 * during the daily TTL sweep. `touch()` is permissionless (see lib.rs) but
 * every call still round-trips through the SAME admin-signed serial queue as
 * real resolve()/refund()/charge() settlement calls (see serializeAdminCall
 * in stellarClient.js) — so touching a worker that has never staked or been
 * credited is pure queue-time waste that can delay a payer or worker's
 * money. A worker is only worth touching when there is off-chain evidence
 * it has on-chain state to refresh: a cached stake (setCachedStake) or a
 * recorded resolve()-credited outcome (reputation.total > 0). Factored out
 * as a pure function, matching this file's existing convention (see
 * stakeGateAllows, computeSmoothedCount), so the skip/include decision is
 * directly testable without a live store or chain.
 */
export function shouldSweepWorkerTtl({ cachedStake, reputation } = {}) {
  if (cachedStake !== undefined) return true;
  return (reputation?.total ?? 0) > 0;
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
 *
 * `whitelist` (a payer's private pool — see privatePools.js) is the one
 * filter here that deliberately FAILS CLOSED. Every other filter is a soft
 * routing preference, so falling back to a wider pool beats stranding the
 * question. A private pool is a hard requirement the payer explicitly asked
 * for; falling back to the open pool would quietly defeat the feature and
 * send their question to exactly the workers they excluded. So it runs
 * first, and when no whitelisted worker is online this returns [] (the
 * caller refunds rather than broadcasting). The soft filters below still
 * fail open, but only as far as the whitelisted set, never past it.
 */
async function selectTargets(category, { preferEstablished = false, quorumSize = 0, whitelist = null } = {}) {
  let targets = [...workers.entries()];

  if (whitelist) {
    const allowed = new Set(whitelist);
    targets = targets.filter(([id]) => allowed.has(id));
    if (targets.length === 0) return [];
  }

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

export async function broadcast(questionId, questionText, { category, quorumSize, expiresInMs, preferEstablished, whitelist, traceparent } = {}) {
  // Re-enter the question's trace context (generated at creation time in
  // jobs.js) so the dispatch span is a child of the same trace, and inject
  // the current traceparent into the SSE payload so workers can echo it back
  // on their answers — closing the loop across the SSE boundary.
  const parentCtx = contextFromTraceparent(traceparent);
  return context.with(parentCtx, async () => {
    const span = tracer().startSpan('dispatch.broadcast', {
      kind: SpanKind.PRODUCER,
      attributes: {
        'question.id': questionId.toString(),
        'dispatch.category': category || 'general',
        'dispatch.quorum_size': quorumSize || 0,
      },
    });
    try {
      const payload = {
        questionId: questionId.toString(),
        question: questionText,
        quorumSize,
        expiresInMs,
        traceparent: currentTraceparent(),
      };
      const targets = await selectTargets(category, { preferEstablished, quorumSize, whitelist });
      span.setAttribute('dispatch.recipients', targets.length);
      for (const [, w] of targets) writeSse(w.res, 'question', payload);

      // Supplement SSE with push notifications for workers who are eligible
      // but not currently connected — only when the timeout window realistically
      // allows time to notice, tap, and load before the quorum closes (see
      // push.js for the honest tradeoff; short-timeout tiers skip this).
      if (expiresInMs > 0) {
        const eligibleIds = await getPushEligibleWorkerIds([...targets].map(([id]) => id));
        for (const workerId of eligibleIds) {
          await notifyWorker(workerId, payload);
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return targets.map(([id]) => id);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Record the on-chain settlement transaction hash against the question's
 * trace. Soroban has no native tracing concept, so the traceparent is carried
 * in the transaction memo (see stellarClient.js) and the resulting hash is
 * attached here as a span attribute — this is what lets an operator walk from
 * a trace ID to the exact on-chain transaction.
 */
export async function recordSettlement(questionId, txHash, { traceparent } = {}) {
  const parentCtx = contextFromTraceparent(traceparent);
  return context.with(parentCtx, async () => {
    const span = tracer().startSpan('settlement.onchain', {
      kind: SpanKind.CLIENT,
      attributes: {
        'question.id': questionId.toString(),
        'settlement.tx_hash': txHash,
      },
    });
    try {
      await touchWorker('settlement', { questionId: questionId.toString(), txHash });
      span.setStatus({ code: SpanStatusCode.OK });
      return txHash;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Register the quorum collector for a question, running inside the question's
 * trace context so the eventual finish() callback (which triggers settlement)
 * stays on the same trace.
 */
export function registerCollector(questionId, { quorumSize, finish, traceparent, whitelist = null } = {}) {
  const parentCtx = contextFromTraceparent(traceparent);
  const collector = {
    submissions: new Map(),
    quorumSize,
    finished: false,
    whitelist: whitelist ? new Set(whitelist) : null,
    finish: (submissions) => context.with(parentCtx, () => finish(submissions)),
  };
  collectors.set(questionId.toString(), collector);
  return collector;
}

export function getCollector(questionId) {
  return collectors.get(questionId.toString());
}

export function clearCollector(questionId) {
  collectors.delete(questionId.toString());
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
 * opportunities for a meaningful stretch to move the price.
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

/** True when at least one worker in `whitelist` is currently connected. */
export function hasOnlineWhitelistedWorker(whitelist) {
  if (!whitelist || whitelist.length === 0) return false;
  return whitelist.some((id) => workers.has(id));
}

/** The SSE `suggestion` frame body. Deliberately unverified: it is a
 * worker-side hint and is never counted as a submission. */
export function buildSuggestionPayload(questionId, draft) {
  return {
    questionId: questionId.toString(),
    suggestedAnswer: draft.consensus,
    suggestedConfidence: draft.confidence,
    unverified: true,
  };
}

/**
 * Dispatches a question to eligible workers and resolves with the answers
 * that arrived. Resolves early once quorum is reached, immediately when no
 * one is reachable, and otherwise at timeoutMs with whatever arrived. Never
 * rejects, so settlement downstream always gets a list it can reconcile.
 *
 * `suggestion` is an optional draft promise. It is delivered as a separate
 * SSE frame once it resolves, so a slow draft can never delay the question,
 * and it never counts toward quorum.
 */
export function dispatchAndCollect(questionId, questionText, {
  quorumSize,
  timeoutMs,
  category,
  preferEstablished,
  whitelist,
  suggestion,
} = {}) {
  const qid = questionId.toString();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (submissionsMap) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      clearCollector(qid);
      resolve([...submissionsMap.entries()].map(([workerId, answer]) => ({ workerId, answer })));
    };

    registerCollector(qid, { quorumSize, finish, traceparent: currentTraceparent(), whitelist });
    timer = setTimeout(() => finish(getCollector(qid)?.submissions ?? new Map()), timeoutMs);

    broadcast(qid, questionText, {
      category,
      quorumSize,
      expiresInMs: timeoutMs,
      preferEstablished,
      whitelist,
      traceparent: currentTraceparent(),
    })
      .then((recipientIds) => {
        if (recipientIds.length === 0) finish(new Map());
      })
      .catch((err) => {
        logger.warn({ err, questionId: qid }, 'broadcast failed during dispatchAndCollect');
        finish(new Map());
      });

    if (suggestion) {
      Promise.resolve(suggestion)
        .then(async (draft) => {
          if (!draft || done) return;
          const targets = await selectTargets(category, { preferEstablished, quorumSize, whitelist });
          for (const [, w] of targets) writeSse(w.res, 'suggestion', buildSuggestionPayload(qid, draft));
        })
        .catch(() => {});
    }
  });
}


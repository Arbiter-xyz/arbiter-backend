import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { screenAnswer } from './answerFilter.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { getStakeOnChain, touchWorker } from './stellarClient.js';
import { jobLogger, logger } from './logger.js';
import { isCollusionSuspended } from './collusion.js';
import { exactMatchVote } from './vote.js';
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
const ANSWER_CHANNEL_PREFIX = 'quorum:answer:';

function answerChannel(questionId) {
  return ANSWER_CHANNEL_PREFIX + questionId;
}

const answerSubscriptions = new Map();

async function subscribeToAnswers(questionId) {
  if (typeof store.subscribe !== 'function') return;
  if (answerSubscriptions.has(questionId)) return;
  try {
    const unsubscribe = await store.subscribe(answerChannel(questionId), (payload) => {
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

async function publishAnswer(questionId, workerId, answer, traceparent) {
  if (typeof store.publish !== 'function') return false;
  try {
    await store.publish(answerChannel(questionId), { questionId, workerId, answer, traceparent });
    return true;
  } catch (err) {
    logger.warn({ err, questionId, workerId }, 'failed to publish cross-instance answer');
    return false;
  }
}

export function submitAnswer(questionId, workerId, answer, traceparent) {
  const qid = questionId.toString();
  if (collectors.has(qid)) {
    return handleAnswer(qid, workerId, answer, traceparent);
  }
  return publishAnswer(qid, workerId, answer, traceparent);
}

function handleAnswer(questionId, workerId, answer, traceparent) {
  const qid = questionId.toString();
  const parentCtx = contextFromTraceparent(traceparent);
  return context.with(parentCtx, () => {
    const span = tracer().startSpan('dispatch.answer', {
      kind: SpanKind.CONSUMER,
      attributes: {
        'question.id': qid,
        'worker.id': workerId,
      },
    });
    try {
      const collector = collectors.get(qid);
      if (!collector || collector.finished) {
        span.setAttribute('dispatch.answer_accepted', false);
        return false;
      }
      if (collector.whitelist && !collector.whitelist.has(workerId)) {
        span.setAttribute('dispatch.answer_accepted', false);
        return false;
      }
      if (collector.submissions.has(workerId)) {
        span.setAttribute('dispatch.answer_accepted', false);
        span.setAttribute('dispatch.answer_duplicate', true);
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
      if (collector.escalation) {
        collector.escalation.onSubmission();
      } else if (collector.submissions.size >= collector.quorumSize) {
        collector.finished = true;
        unsubscribeFromAnswers(qid);
        Promise.resolve(collector.finish(collector.submissions)).catch((err) => {
          logger.warn({ err, questionId: qid }, 'collector finish failed');
        });
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
export async function readPresence() {
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
  const now = Date.now();
  for (const [workerId, json] of Object.entries(raw || {})) {
    try {
      const parsed = JSON.parse(json);
      let expired = false;
      if (typeof client.get === 'function') {
        const keyVal = await client.get(presenceKey(workerId));
        if (keyVal === null || keyVal === undefined) expired = true;
      } else if (typeof client.ttl === 'function') {
        const ttl = await client.ttl(presenceKey(workerId));
        if (ttl === -2) expired = true;
      } else if (parsed.connectedAt && now - parsed.connectedAt > PRESENCE_TTL_SECONDS * 1000) {
        expired = true;
      }
      if (expired) {
        if (typeof client.hdel === 'function') {
          await client.hdel(PRESENCE_PREFIX + 'workers', workerId);
        }
        continue;
      }
      presence.set(workerId, parsed);
    } catch {
      // Ignore malformed entries rather than failing the whole read.
    }
  }
  return presence;
}

export async function onlineWorkerCount() {
  return (await readPresence()).size;
}

export function getWorkerConnectedAt(workerId) {
  return workers.get(workerId)?.connectedAt ?? null;
}

function normalizeCategory(category) {
  return String(category).trim().toLowerCase();
}

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
 * workers expire automatically instead of lingering forever (#271).
 */
export async function writePresence(workerId, categories) {
  const client = store.getClient && store.getClient();
  if (!client) return;
  const record = JSON.stringify({ categories, connectedAt: Date.now() });
  const key = presenceKey(workerId);
  if (typeof client.set === 'function') {
    await client.set(key, record);
  }
  await client.hset(PRESENCE_PREFIX + 'workers', workerId, record);
  if (typeof client.expire === 'function') {
    await client.expire(key, PRESENCE_TTL_SECONDS);
  }
}

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

export async function getReputation(workerId) {
  return (await store.get(REPUTATION_PREFIX + workerId)) || { matched: 0, total: 0 };
}

export async function recordOutcome(workerId, matched) {
  const key = REPUTATION_PREFIX + workerId;
  const rec = (await store.get(key)) || { matched: 0, total: 0 };
  const isNew = rec.total === 0;
  rec.total += 1;
  if (matched) rec.matched += 1;
  await store.set(key, rec);

  if (isNew) {
    const known = (await store.get(WORKER_INDEX_KEY)) || [];
    if (!known.includes(workerId)) {
      await store.set(WORKER_INDEX_KEY, [workerId, ...known].slice(0, MAX_TRACKED_WORKERS));
    }
  }

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

const stakeCache = new Map(); // workerId -> stroops (bigint)

export function setCachedStake(workerId, stroops) {
  if (stroops === undefined || stroops === null) {
    stakeCache.delete(workerId);
  } else {
    stakeCache.set(workerId, typeof stroops === 'bigint' ? stroops : BigInt(stroops));
  }
}

export function getCachedStake(workerId) {
  return stakeCache.get(workerId);
}

export function stakeGateAllows(cachedStake, minStakeStroops) {
  if (minStakeStroops <= 0n) return true;
  if (cachedStake === undefined) return true;
  return cachedStake >= minStakeStroops;
}

async function isEligible(workerId) {
  if (await isCollusionSuspended(workerId)) return false;
  const rep = await getReputation(workerId);
  if (rep.total < config.worker.minAnswersBeforeReputationGate) return true;
  if (rep.matched / rep.total < config.worker.minMatchRatio) return false;
  return stakeGateAllows(stakeCache.get(workerId), config.worker.minStakeStroops);
}

export async function isEstablishedWorker(workerId) {
  const rep = await getReputation(workerId);
  return rep.total >= config.worker.minAnswersBeforeReputationGate;
}

export function shouldSweepWorkerTtl({ cachedStake, reputation } = {}) {
  if (cachedStake !== undefined) return true;
  return (reputation?.total ?? 0) > 0;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function selectTargets(category, { preferEstablished = false, quorumSize = 0, whitelist = null } = {}) {
  let targets = [...workers.entries()];

  if (whitelist) {
    const allowed = new Set(whitelist);
    targets = targets.filter(([id]) => allowed.has(id));
    if (targets.length === 0) return [];
  }

  if (category) {
    const norm = normalizeCategory(category);
    const matching = targets.filter(([, w]) => w.categories.size === 0 || w.categories.has(norm));
    if (matching.length > 0) targets = matching;
  }

  const eligible = [];
  for (const entry of targets) {
    if (await isEligible(entry[0])) eligible.push(entry);
  }
  const pool = eligible.length > 0 ? eligible : targets;
  if (!preferEstablished) return pool;

  const established = [];
  for (const entry of pool) {
    if (await isEstablishedWorker(entry[0])) established.push(entry);
  }
  return established.length >= quorumSize ? established : pool;
}

export async function broadcast(
  questionId,
  questionText,
  { category, quorumSize, expiresInMs, preferEstablished, whitelist, limit, exclude, traceparent } = {},
) {
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
      let targets = await selectTargets(category, { preferEstablished, quorumSize, whitelist });
      if (exclude) targets = targets.filter(([id]) => !exclude.has(id));
      if (limit !== undefined) {
        const ranked = await Promise.all(
          targets.map(async (entry) => ({ entry, established: await isEstablishedWorker(entry[0]) })),
        );
        ranked.sort((a, b) => Number(b.established) - Number(a.established));
        targets = ranked.slice(0, limit).map((r) => r.entry);
      }
      span.setAttribute('dispatch.recipients', targets.length);
      for (const [, w] of targets) writeSse(w.res, 'question', payload);

      if (limit === undefined && expiresInMs > 0) {
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

const SUPPLY_SAMPLE_INTERVAL_MS = 5_000;
const SUPPLY_WINDOW_SAMPLES = 12;
const supplySamples = [];

const supplySamplerHandle = setInterval(() => {
  supplySamples.push(workers.size);
  if (supplySamples.length > SUPPLY_WINDOW_SAMPLES) supplySamples.shift();
}, SUPPLY_SAMPLE_INTERVAL_MS);
supplySamplerHandle.unref?.();

export function computeSmoothedCount(samples, currentCount) {
  if (samples.length === 0) return currentCount;
  const sum = samples.reduce((a, b) => a + b, 0);
  return Math.round(sum / samples.length);
}

export function getSmoothedOnlineWorkerCount() {
  return computeSmoothedCount(supplySamples, workers.size);
}

export function hasOnlineWhitelistedWorker(whitelist) {
  if (!whitelist || whitelist.length === 0) return false;
  return whitelist.some((id) => workers.has(id));
}

export function buildSuggestionPayload(questionId, draft) {
  return {
    questionId: questionId.toString(),
    suggestedAnswer: draft.consensus,
    suggestedConfidence: draft.confidence,
    unverified: true,
  };
}

async function annotateEstablished(submissions) {
  return Promise.all(submissions.map(async (s) => ({ ...s, established: await isEstablishedWorker(s.workerId) })));
}

export function dispatchAndCollect(
  questionId,
  questionText,
  { quorumSize, timeoutMs, category, preferEstablished, whitelist, suggestion } = {},
) {
  const qid = questionId.toString();
  return new Promise((resolvePromise) => {
    let done = false;
    let timer = null;
    const finish = (submissionsMap) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      clearCollector(qid);
      unsubscribeFromAnswers(qid);
      const raw = [...(submissionsMap ?? new Map()).entries()].map(([workerId, answer]) => ({ workerId, answer }));
      annotateEstablished(raw)
        .then(resolvePromise)
        .catch(() => resolvePromise(raw.map((s) => ({ ...s, established: false }))));
    };

    registerCollector(qid, { quorumSize, finish, traceparent: currentTraceparent(), whitelist });
    subscribeToAnswers(qid).catch(() => {});
    timer = setTimeout(() => finish(getCollector(qid)?.submissions ?? new Map()), timeoutMs);
    timer.unref?.();

    broadcast(qid, questionText, {
      category,
      quorumSize,
      expiresInMs: timeoutMs,
      preferEstablished,
      whitelist,
      traceparent: currentTraceparent(),
    })
      .then((recipientIds) => {
        if (!recipientIds || recipientIds.length === 0) finish(new Map());
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

export function singleAnswerConfidence(rep, minAnswersBeforeEstablished) {
  if (rep.total < minAnswersBeforeEstablished) return 0;
  return (rep.matched + 1) / (rep.total + 2);
}

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
    timer.unref?.();

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
      onSubmission() {
        evalChain = evalChain.then(evaluate).catch((err) => jobLogger(questionId).error({ err }, 'escalation evaluation failed'));
      },
    };

    recruit(initialQuorum).catch((err) => {
      jobLogger(questionId).error({ err }, 'broadcast failed');
    });
  });
}

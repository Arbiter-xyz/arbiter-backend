import { store } from './store.js';
import { config } from './config.js';
import { checkRateLimit } from './rateLimit.js';
import { getPushEligibleWorkerIds, notifyWorker } from './push.js';
import { getStakeOnChain, touchWorker } from './stellarClient.js';
import { jobLogger, logger } from './logger.js';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';

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

export async function broadcast(questionId, questionText, { category, quorumSize, expiresInMs, preferEstablished, traceparent } = {}) {
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
      const targets = await selectTargets(category, { preferEstablished, quorumSize });
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
      return targets.length;
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
 * Record a worker's answer inside the question's trace context. The worker
 * echoes the traceparent it received on the SSE frame, so the answer span is
 * correlated with the original HTTP request and the on-chain settlement that
 * follows — this is the middle link in the end-to-end trace.
 */
export async function submitAnswer(questionId, workerId, answer, { traceparent } = {}) {
  const parentCtx = contextFromTraceparent(traceparent);
  return context.with(parentCtx, async () => {
    const span = tracer().startSpan('dispatch.answer', {
      kind: SpanKind.CONSUMER,
      attributes: {
        'question.id': questionId.toString(),
        'worker.id': workerId,
      },
    });
    try {
      const collector = collectors.get(questionId.toString());
      if (!collector || collector.finished) {
        span.setAttribute('dispatch.answer_accepted', false);
        return false;
      }
      collector.submissions.set(workerId, answer);
      span.setAttribute('dispatch.answer_accepted', true);
      span.setAttribute('dispatch.submissions', collector.submissions.size);
      if (collector.submissions.size >= collector.quorumSize) {
        collector.finished = true;
        await collector.finish(collector.submissions);
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
export function registerCollector(questionId, { quorumSize, finish, traceparent } = {}) {
  const parentCtx = contextFromTraceparent(traceparent);
  const collector = {
    submissions: new Map(),
    quorumSize,
    finished: false,
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

// Re-exported so jobs.js and the HTTP layer can start the root span at
// question-creation time without importing @opentelemetry/api directly.
export { tracer, context, propagation, SpanKind, SpanStatusCode };

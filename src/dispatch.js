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
 *
 * `whitelist` (a payer's private pool — see privatePools.js) is the one
 * filter here 

/* … truncated 7639 chars — edit only what you need near the top … */

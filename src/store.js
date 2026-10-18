import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Storage abstraction so pendingQuestions/jobs/reputation/rate-limits
 * survive a backend restart and can be shared across instances, without
 * forcing Redis on anyone who just wants to run this locally.
 *
 * Falls back to an in-memory Map automatically when REDIS_URL is unset or
 * unreachable — that fallback is a single-instance, restart-loses-state
 * mode, which is fine for local dev/demo but not for production replicas.
 *
 * NOT covered by this abstraction: the live worker SSE registry and the
 * per-question quorum collector in dispatch.js. Those hold open socket
 * objects and in-process timers, which are inherently tied to whichever
 * process accepted the connection. dispatch.js fans
 * those out across instances using getClient()/setNX()/hsetnx()/hgetall()
 * below as the coordination primitives.
 */

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlMs) {
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }

  async delete(key) {
    this.map.delete(key);
  }

  /**
   * Deliberately has NO `await` in its body, even though it's declared
   * async. JS's run-to-completion guarantee for synchronous code means the
   * read-modify-write below can't be interleaved by another queued incr()
   * call the way `await this.get(key)` followed by `await this.set(...)`
   * could be (two awaits create two separate points where concurrent
   * callers — e.g. a burst of requests from the same IP hitting the rate
   * limiter — can interleave and both read the same stale value). Only the
   * function's return value is wrapped in a Promise asynchronously.
   */
  async incr(key, ttlMs) {
    const entry = this.map.get(key);
    const now = Date.now();
    const current = entry && (!entry.expiresAt || entry.expiresAt >= now) ? entry.value : 0;
    const next = current + 1;
    this.map.set(key, { value: next, expiresAt: ttlMs ? now + ttlMs : null });
    return next;
  }

  // No Redis client to hand out — callers that need one (dispatch.js's
  // cross-instance presence) treat null as single-instance mode, same
  // "no Redis, no distributed anything" trade-off as every other feature in
  // this file.
  getClient() {
    return null;
  }

  /** Same run-to-completion-safe check-then-set discipline as incr() above:
   * no `await` between the read and the write, so two concurrent callers
   * for the same key can't both observe "not set yet." */
  async setNX(key, value, ttlMs) {
    const entry = this.map.get(key);
    const now = Date.now();
    if (entry && (!entry.expiresAt || entry.expiresAt >= now)) return false;
    this.map.set(key, { value, expiresAt: ttlMs ? now + ttlMs : null });
    return true;
  }

  /** A hash living under one KV key, dedup'd per field — the answer-
   * collection primitive: many workers (fields) racing to write into one
   * question's (key's) hash, each exactly once. TTL is set only on the
   * hash's first-ever field, mirroring incr()'s TTL-on-first-write; later
   * fields extend the same entry without resetting its expiry. */
  async hsetnx(key, field, value, ttlMs) {
    const now = Date.now();
    const entry = this.map.get(key);
    const alive = entry && (!entry.expiresAt || entry.expiresAt >= now);
    const hash = alive ? entry.value : {};
    if (Object.prototype.hasOwnProperty.call(hash, field)) return false;
    hash[field] = value;
    this.map.set(key, { value: hash, expiresAt: alive ? entry.expiresAt : ttlMs ? now + ttlMs : null });
    return true;
  }

  async hgetall(key) {
    const entry = this.map.get(key);
    if (!entry) return {};
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return {};
    }
    return { ...entry.value };
  }

  /** Durable accumulator — no TTL, matching every other money-like balance
   * in this codebase (Owed, reputation, payer records): a credit balance
   * must never silently expire. Same run-to-completion-safe check-then-
   * write discipline as incr(). */
  async incrBy(key, delta) {
    const entry = this.map.get(key);
    const next = (entry ? entry.value : 0) + delta;
    this.map.set(key, { value: next, expiresAt: null });
    return next;
  }

  /** Atomic conditional decrement — the credit-reservation primitive: only
   * succeeds if the balance can afford `amount`, so two concurrent
   * reservations against the same account can never both succeed against
   * funds that only cover one of them. */
  async decrIfAtLeast(key, amount) {
    const entry = this.map.get(key);
    const current = entry ? entry.value : 0;
    if (current < amount) return false;
    this.map.set(key, { value: current - amount, expiresAt: null });
    return true;
  }

  /** Cluster-wide worker presence: each instance registers its own live
   * worker count under a per-instance field in one shared hash, so a
   * cluster-wide total is a sum over fields rather than a per-process
   * number. MemoryStore has no peers, so its own field is the whole
   * cluster — identical to today's single-instance behavior. */
  async setPresence(instanceId, count, ttlMs) {
    const key = 'presence:workers';
    const now = Date.now();
    const entry = this.map.get(key);
    const alive = entry && (!entry.expiresAt || entry.expiresAt >= now);
    const hash = alive ? entry.value : {};
    hash[instanceId] = { count, at: now };
    this.map.set(key, { value: hash, expiresAt: ttlMs ? now + ttlMs : null });
  }

  async getPresence() {
    const key = 'presence:workers';
    const entry = this.map.get(key);
    if (!entry) return {};
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return {};
    }
    const result = {};
    for (const [field, value] of Object.entries(entry.value)) {
      result[field] = value.count;
    }
    return result;
  }
}

// Exported (unlike MemoryStore) so its methods are directly unit-testable
// against a lightweight fake ioredis client — this codebase has no real
// Redis in CI, so this is the only way RedisStore's own logic (the Lua
// script in particular) ever actually runs under test, rather than just
// being trusted to be correct by inspection.
export class RedisStore {
  constructor(client) {
    this.client = client;
  }

  async get(key) {
    const raw = await this.client.get(key);
    return raw === null ? null : JSON.parse(raw);
  }

  async set(key, value, ttlMs) {
    const raw = JSON.stringify(value);
    if (ttlMs) await this.client.set(key, raw, 'PX', ttlMs);
    else await this.client.set(key, raw);
  }

  async delete(key) {
    await this.client.del(key);
  }

  async incr(key, ttlMs) {
    const next = await this.client.incr(key);
    if (next === 1 && ttlMs) await this.client.pexpire(key, ttlMs);
    return next;
  }

  getClient() {
    return this.client;
  }

  async setNX(key, value, ttlMs) {
    const raw = JSON.stringify(value);
    const result = ttlMs
      ? await this.client.set(key, raw, 'PX', ttlMs, 'NX')
      : await this.client.set(key, raw, 'NX');
    return result === 'OK';
  }

  async hsetnx(key, field, value, ttlMs) {
    const wasSet = await this.client.hsetnx(key, field, JSON.stringify(value));
    if (wasSet === 1 && ttlMs) await this.client.pexpire(key, ttlMs);
    return wasSet === 1;
  }

  async hgetall(key) {
    const raw = await this.client.hgetall(key);
    const result = {};
    for (const [field, value] of Object.entries(raw)) {
      result[field] = JSON.parse(value);
    }
    return result;
  }

  // Durable — no TTL, matching MemoryStore's incrBy (money-like balances
  // must never expire).
  async incrBy(key, delta) {
    return this.client.incrby(key, delta);
  }

  // Atomic conditional decrement via a Lua script so the read-compare-write
  // can't interleave with a concurrent reservation on the same account.
  async decrIfAtLeast(key, amount) {
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local amount = tonumber(ARGV[1])
      if current < amount then return 0 end
      redis.call('SET', KEYS[1], current - amount)
      return 1
    `;
    const result = await this.client.eval(script, 1, key, amount);
    return result === 1;
  }

  async setPresence(instanceId, count, ttlMs) {
    const key = 'presence:workers';
    await this.client.hset(key, instanceId, JSON.stringify({ count, at: Date.now() }));
    if (ttlMs) await this.client.pexpire(key, ttlMs);
  }

  async getPresence() {
    const raw = await this.client.hgetall('presence:workers');
    const result = {};
    for (const [field, value] of Object.entries(raw)) {
      result[field] = JSON.parse(value).count;
    }
    return result;
  }
}

async function createStore() {
  if (!config.redisUrl) {
    logger.info('REDIS_URL not set — using in-memory store (single-instance only)');
    return new MemoryStore();
  }
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    await client.ping();
    logger.info('Connected to Redis — using RedisStore');
    return new RedisStore(client);
  } catch (err) {
    logger.warn({ err }, 'Redis unavailable — falling back to in-memory store (single-instance only)');
    return new MemoryStore();
  }
}

export const store = await createStore();

/**
 * Federation reputation credentials (#86).
 *
 * A worker with established reputation on deployment A can present a signed,
 * portable credential to deployment B so B's dispatch.js::isEligible() can
 * accept it without B trusting A's API by fiat. The credential is signed by
 * A's federation key (config.worker.federation.signingKey) and carries the
 * origin deployment id, workerId, matched/total counts, and an issuedAt
 * timestamp. B verifies the signature against the origin's published key
 * (config.worker.federation.trustedOrigins) before accepting it.
 *
 * Federation is opt-in: when config.worker.federation.enabled is false,
 * verifyFederatedReputation() always returns null and callers fall back to
 * the local rep: record exactly as before.
 */

function federationConfig() {
  return (config.worker && config.worker.federation) || {};
}

function canonicalCredentialPayload(cred) {
  // Deterministic field order so signer and verifier hash identical bytes.
  return JSON.stringify({
    origin: cred.origin,
    workerId: cred.workerId,
    matched: cred.matched,
    total: cred.total,
    issuedAt: cred.issuedAt,
  });
}

/**
 * Sign a reputation credential with the local deployment's federation key.
 * Returns the credential object (including `signature`) or null when
 * federation is disabled / no signing key is configured.
 */
export function signReputationCredential({ workerId, matched, total }) {
  const fed = federationConfig();
  if (!fed.enabled || !fed.signingKey || !fed.deploymentId) return null;
  const cred = {
    origin: fed.deploymentId,
    workerId,
    matched,
    total,
    issuedAt: Date.now(),
  };
  cred.signature = createHmac('sha256', fed.signingKey)
    .update(canonicalCredentialPayload(cred))
    .digest('hex');
  return cred;
}

/**
 * Verify a presented credential. Returns the credential's { matched, total }
 * when the signature is valid and the origin is trusted, otherwise null.
 * A forged/tampered credential (e.g. inflated matched/total with an invalid
 * signature) is rejected here.
 */
export function verifyFederatedReputation(cred) {
  const fed = federationConfig();
  if (!fed.enabled) return null;
  if (!cred || typeof cred !== 'object') return null;
  const { origin, workerId, matched, total, issuedAt, signature } = cred;
  if (typeof origin !== 'string' || typeof workerId !== 'string') return null;
  if (!Number.isFinite(matched) || !Number.isFinite(total)) return null;
  if (matched < 0 || total < 0 || matched > total) return null;
  if (typeof signature !== 'string') return null;

  const trusted = fed.trustedOrigins || {};
  const originKey = trusted[origin];
  if (!originKey) return null;

  const expected = createHmac('sha256', originKey)
    .update(canonicalCredentialPayload({ origin, workerId, matched, total, issuedAt }))
    .digest('hex');

  // Constant-time compare to avoid leaking signature bytes via timing.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { matched, total, origin };
}

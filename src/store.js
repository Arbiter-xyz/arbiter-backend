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
 * process accepted the connection. See pubsub.js for how dispatch.js fans
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

  // No Redis client to duplicate a pub/sub connection from — see pubsub.js's
  // createPubSub(), which falls back to an in-process broker when this
  // returns null, same "no Redis, no distributed anything" trade-off as
  // every other feature in this file.
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
}

class RedisStore {
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
}

async function createStore() {
  if (!config.redisUrl) {
    logger.info('REDIS_URL not set — using in-memory store (single-instance only)');
    return new MemoryStore();
  }
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    client.on('error', (err) => logger.error({ err }, 'redis error'));
    logger.info('connected to Redis — state survives restarts and can be shared across instances');
    return new RedisStore(client);
  } catch (err) {
    logger.error({ err }, 'failed to connect to Redis — falling back to in-memory store');
    return new MemoryStore();
  }
}

export const store = await createStore();

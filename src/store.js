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
 * process accepted the connection. Running more than one backend instance
 * behind a load balancer would need a pub/sub fan-out (e.g. Redis pub/sub)
 * so a question dispatched on instance A reaches a worker connected to
 * instance B — that's a real follow-up, not implemented here.
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

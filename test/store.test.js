import test from 'node:test';
import assert from 'node:assert/strict';
import { store, RedisStore } from '../src/store.js';

function uniqueKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// This test suite otherwise only exercises MemoryStore (no Redis in CI —
// see README). RedisStore.incrBy/decrIfAtLeast were a real gap: they
// existed on MemoryStore but not RedisStore, so any Redis-backed
// deployment would crash on the first fiat-billing request. A minimal
// fake ioredis client — real enough for get/set/incrby/hsetnx/hgetall,
// and for eval() a faithful re-implementation of what the Lua script
// actually does (a real Lua interpreter isn't available without a real
// Redis instance) — is what makes RedisStore's own logic runnable at all
// under test, not just trusted by inspection.
class FakeRedisClient {
  constructor() {
    this.data = new Map();
    this.hashes = new Map();
  }
  async get(key) {
    return this.data.has(key) ? String(this.data.get(key)) : null;
  }
  async set(key, value, ...args) {
    if (args.includes('NX') && this.data.has(key)) return null;
    this.data.set(key, value);
    return 'OK';
  }
  async del(key) {
    this.data.delete(key);
  }
  async incr(key) {
    const next = (Number(this.data.get(key)) || 0) + 1;
    this.data.set(key, String(next));
    return next;
  }
  async incrby(key, delta) {
    const next = (Number(this.data.get(key)) || 0) + Number(delta);
    this.data.set(key, String(next));
    return next;
  }
  async pexpire() {}
  async hsetnx(key, field, value) {
    const hash = this.hashes.get(key) || {};
    if (Object.prototype.hasOwnProperty.call(hash, field)) return 0;
    hash[field] = value;
    this.hashes.set(key, hash);
    return 1;
  }
  async hgetall(key) {
    return this.hashes.get(key) || {};
  }
  async eval(_script, _numKeys, key, amount) {
    const current = Number(this.data.get(key)) || 0;
    const amt = Number(amount);
    if (current < amt) return 0;
    this.data.set(key, String(current - amt));
    return 1;
  }
}

test('RedisStore.incrBy delegates to INCRBY and accumulates', async () => {
  const redisStore = new RedisStore(new FakeRedisClient());
  const key = uniqueKey('credit');
  assert.equal(await redisStore.incrBy(key, 100), 100);
  assert.equal(await redisStore.incrBy(key, 50), 150);
  assert.equal(await redisStore.incrBy(key, -30), 120);
});

test('RedisStore.decrIfAtLeast refuses when the balance is insufficient, leaving it unchanged', async () => {
  const redisStore = new RedisStore(new FakeRedisClient());
  const key = uniqueKey('credit');
  await redisStore.incrBy(key, 50);
  assert.equal(await redisStore.decrIfAtLeast(key, 100), false);
  assert.equal(await redisStore.incrBy(key, 0), 50); // unchanged by the refused attempt
});

test('RedisStore.decrIfAtLeast succeeds when the balance covers the amount', async () => {
  const redisStore = new RedisStore(new FakeRedisClient());
  const key = uniqueKey('credit');
  await redisStore.incrBy(key, 100);
  assert.equal(await redisStore.decrIfAtLeast(key, 60), true);
  assert.equal(await redisStore.incrBy(key, 0), 40);
});

test('RedisStore.decrIfAtLeast treats a never-written key as a zero balance', async () => {
  const redisStore = new RedisStore(new FakeRedisClient());
  assert.equal(await redisStore.decrIfAtLeast(uniqueKey('credit'), 1), false);
});

test('setNX only succeeds the first time for a given key', async () => {
  const key = uniqueKey('nx');
  assert.equal(await store.setNX(key, 1), true);
  assert.equal(await store.setNX(key, 2), false);
  assert.equal(await store.get(key), 1); // the second call must not overwrite
});

test('hsetnx dedupes per field, independently per key', async () => {
  const key = uniqueKey('hash');
  assert.equal(await store.hsetnx(key, 'workerA', 'yes'), true);
  assert.equal(await store.hsetnx(key, 'workerA', 'no'), false); // dup field, refused
  assert.equal(await store.hsetnx(key, 'workerB', 'yes'), true); // different field, fine
  assert.deepEqual(await store.hgetall(key), { workerA: 'yes', workerB: 'yes' });
});

test('hgetall on a never-written key returns an empty object, not null/undefined', async () => {
  assert.deepEqual(await store.hgetall(uniqueKey('missing')), {});
});

test('incrBy accumulates positive and negative deltas, durably (no TTL)', async () => {
  const key = uniqueKey('credit');
  assert.equal(await store.incrBy(key, 100), 100);
  assert.equal(await store.incrBy(key, 50), 150);
  assert.equal(await store.incrBy(key, -30), 120);
  assert.equal(await store.get(key), 120);
});

test('decrIfAtLeast refuses when the balance is insufficient, leaving it unchanged', async () => {
  const key = uniqueKey('credit');
  await store.incrBy(key, 50);
  assert.equal(await store.decrIfAtLeast(key, 100), false);
  assert.equal(await store.get(key), 50); // untouched by the refused attempt
});

test('decrIfAtLeast succeeds atomically when the balance covers the amount', async () => {
  const key = uniqueKey('credit');
  await store.incrBy(key, 100);
  assert.equal(await store.decrIfAtLeast(key, 60), true);
  assert.equal(await store.get(key), 40);
});

test('decrIfAtLeast treats a never-written key as a zero balance', async () => {
  assert.equal(await store.decrIfAtLeast(uniqueKey('credit'), 1), false);
});

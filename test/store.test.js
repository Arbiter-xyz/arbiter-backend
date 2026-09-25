import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

// ---------------------------------------------------------------------------
// Multi-process Redis-backed concurrency proof (issue #1).
//
// The tests above run against MemoryStore (or a single-process fake). They
// cannot prove that claimJob / session storage / job-state transitions stay
// correct when *separate OS processes* race against the *same* Redis under
// genuine network-latency-shaped interleaving. These tests fork real child
// processes (child_process.fork) that each open their own Redis connection
// and hammer the same keys, then assert the invariants hold.
//
// CI must provide a real Redis (see .github/workflows/ci.yml service
// container). When REDIS_URL is unset the multi-process tests are skipped so
// the suite still runs locally without Redis.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, 'fixtures', 'redis-concurrency-worker.js');

function runWorker(env) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], {
      env: { ...process.env, REDIS_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${out}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (err) {
        reject(new Error(`worker produced no JSON result: ${out}`));
      }
    });
  });
}

test('claimJob is atomic across 2+ real OS processes racing the same Redis', { skip: !REDIS_URL }, async () => {
  const jobId = uniqueKey('job');
  const workers = 4;
  const results = await Promise.all(
    Array.from({ length: workers }, () => runWorker({ MODE: 'claim', JOB_ID: jobId }))
  );
  const winners = results.filter((r) => r.claimed);
  assert.equal(winners.length, 1, 'exactly one process may claim the job');
  assert.equal(results.filter((r) => !r.claimed).length, workers - 1);
});

test('session storage stays consistent across concurrent processes', { skip: !REDIS_URL }, async () => {
  const sessionKey = uniqueKey('session');
  const workers = 4;
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) => runWorker({ MODE: 'session', SESSION_KEY: sessionKey, WORKER_ID: String(i) }))
  );
  // Every process must read back exactly what it wrote, and the final value
  // must be one of the written values (no torn/partial writes).
  for (const r of results) assert.equal(r.readBack, r.wrote);
  const final = await runWorker({ MODE: 'read', SESSION_KEY: sessionKey });
  assert.ok(results.some((r) => r.wrote === final.value), 'final value must be a complete write');
});

test('job-state transitions remain correct under multi-process contention', { skip: !REDIS_URL }, async () => {
  const jobId = uniqueKey('state');
  const workers = 4;
  const results = await Promise.all(
    Array.from({ length: workers }, () => runWorker({ MODE: 'transition', JOB_ID: jobId }))
  );
  // Only one process may move the job out of its initial state; the rest must
  // observe the already-transitioned state rather than clobbering it.
  assert.equal(results.filter((r) => r.transitioned).length, 1);
  const final = await runWorker({ MODE: 'readState', JOB_ID: jobId });
  assert.equal(final.state, 'claimed');
});

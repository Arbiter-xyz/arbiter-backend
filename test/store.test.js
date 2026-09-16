import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';

function uniqueKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

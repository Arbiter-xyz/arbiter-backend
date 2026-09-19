import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeStatus, createSerialQueue } from '../src/stellarClient.js';

// Regression coverage for a real bug found running against a live deployed
// contract on Stellar testnet (round 6): scValToNative decodes a data-less
// Rust enum variant like Status::Pending as a single-element ARRAY
// (['Pending']), not the plain-object shape this function used to assume.
// The old code silently decoded that to "0" (an array's stringified index)
// instead of "pending" — verifyPayment then rejected every real payment
// with "question is 0 on-chain, expected pending". No prior test caught
// this because every other test in this repo only ever exercises mocked
// data, never a real simulateTransaction response.

test('decodeStatus handles the real array shape scValToNative actually produces', () => {
  assert.equal(decodeStatus(['Pending']), 'pending');
  assert.equal(decodeStatus(['Resolved']), 'resolved');
  assert.equal(decodeStatus(['Refunded']), 'refunded');
});

test('decodeStatus still handles a plain string, in case a future SDK version changes shape again', () => {
  assert.equal(decodeStatus('Pending'), 'pending');
});

test('decodeStatus still handles an object-keyed shape as a defensive fallback', () => {
  assert.equal(decodeStatus({ pending: true }), 'pending');
});

test('decodeStatus never throws on an unexpected shape', () => {
  assert.equal(decodeStatus(null), 'null');
  assert.equal(decodeStatus(undefined), 'undefined');
  assert.equal(decodeStatus(0), '0');
});

// Regression coverage for the sequence-number race invokeAsAdmin() used to
// have: every admin-signed contract call re-fetches the account's current
// sequence number, and Stellar requires a strictly increasing, gap-free
// sequence per submitted transaction — two overlapping calls that both
// fetched the same sequence would collide, and in production this
// surfaced as a genuinely-reached consensus getting spuriously refunded
// (oracle.js's settleResolved() falls back to settleRefunded() when the
// admin call exhausts its retries). createSerialQueue() is the fix's
// actual mechanism, factored out standalone so this is testable without
// mocking the RPC layer at all.
test('createSerialQueue runs queued calls one at a time, never overlapping', async () => {
  const serialize = createSerialQueue();
  let concurrentlyRunning = 0;
  let maxConcurrentlyRunning = 0;
  const order = [];

  async function slowCall(id) {
    concurrentlyRunning += 1;
    maxConcurrentlyRunning = Math.max(maxConcurrentlyRunning, concurrentlyRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(id);
    concurrentlyRunning -= 1;
    return id;
  }

  // Fire all three "concurrently" (no await between them) — this is
  // exactly sweepWorkerTtls()'s Promise.all() fan-out shape.
  const results = await Promise.all([1, 2, 3].map((id) => serialize(() => slowCall(id))));

  assert.equal(maxConcurrentlyRunning, 1, 'no two calls should ever be in-flight at the same time');
  assert.deepEqual(order, [1, 2, 3], 'calls should run in the order they were queued');
  assert.deepEqual(results, [1, 2, 3]);
});

test('createSerialQueue does not let one failed call wedge every later call behind it', async () => {
  const serialize = createSerialQueue();

  await assert.rejects(() => serialize(async () => { throw new Error('boom'); }));

  // A later call must still run — a single admin-call failure (e.g. a
  // dropped RPC connection) can never permanently stall the queue for
  // every settlement after it.
  const result = await serialize(async () => 'still works');
  assert.equal(result, 'still works');
});

test('createSerialQueue preserves each call\'s own success/failure outcome to its caller', async () => {
  const serialize = createSerialQueue();

  const [a, bErr, c] = await Promise.allSettled([
    serialize(async () => 'a'),
    serialize(async () => { throw new Error('b failed'); }),
    serialize(async () => 'c'),
  ]);

  assert.equal(a.status, 'fulfilled');
  assert.equal(a.value, 'a');
  assert.equal(bErr.status, 'rejected');
  assert.match(bErr.reason.message, /b failed/);
  assert.equal(c.status, 'fulfilled');
  assert.equal(c.value, 'c');
});

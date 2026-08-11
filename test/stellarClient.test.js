import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeStatus } from '../src/stellarClient.js';

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

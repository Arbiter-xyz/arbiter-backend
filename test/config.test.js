import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEBHOOK_RETRY_POLICY,
  WEBHOOK_RETRY_POLICY_BOUNDS,
  validateWebhookRetryPolicy,
  contractCompatibility,
} from '../src/config.js';

test('validateWebhookRetryPolicy returns the default policy when unset', () => {
  assert.deepEqual(validateWebhookRetryPolicy(undefined), { ...DEFAULT_WEBHOOK_RETRY_POLICY });
  assert.deepEqual(validateWebhookRetryPolicy(null), { ...DEFAULT_WEBHOOK_RETRY_POLICY });
});

test('validateWebhookRetryPolicy accepts an in-range policy unchanged', () => {
  assert.deepEqual(validateWebhookRetryPolicy({ attempts: 3, baseDelayMs: 500 }), {
    attempts: 3,
    baseDelayMs: 500,
  });
});

test('validateWebhookRetryPolicy rejects out-of-range attempts', () => {
  const b = WEBHOOK_RETRY_POLICY_BOUNDS;
  assert.throws(() => validateWebhookRetryPolicy({ attempts: b.minAttempts - 1, baseDelayMs: 500 }), /attempts/);
  assert.throws(() => validateWebhookRetryPolicy({ attempts: b.maxAttempts + 1, baseDelayMs: 500 }), /attempts/);
  assert.throws(() => validateWebhookRetryPolicy({ attempts: 1.5, baseDelayMs: 500 }), /attempts/);
});

test('validateWebhookRetryPolicy rejects out-of-range baseDelayMs', () => {
  const b = WEBHOOK_RETRY_POLICY_BOUNDS;
  assert.throws(() => validateWebhookRetryPolicy({ attempts: 2, baseDelayMs: b.minBaseDelayMs - 1 }), /baseDelayMs/);
  assert.throws(() => validateWebhookRetryPolicy({ attempts: 2, baseDelayMs: b.maxBaseDelayMs + 1 }), /baseDelayMs/);
});

test('contractCompatibility exposes a version and a lowercased wasm hash', () => {
  assert.equal(typeof contractCompatibility.version, 'string');
  assert.equal(contractCompatibility.wasmHash, contractCompatibility.wasmHash.toLowerCase());
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEBHOOK_RETRY_POLICY,
  WEBHOOK_RETRY_POLICY_BOUNDS,
  validateWebhookRetryPolicy,
  contractCompatibility,
  parseMinStakeStroops,
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

test('parseMinStakeStroops parses a valid non-negative integer', () => {
  assert.equal(parseMinStakeStroops('12345'), 12345n);
  assert.equal(parseMinStakeStroops('0'), 0n);
  assert.equal(parseMinStakeStroops(undefined), 0n);
  assert.equal(parseMinStakeStroops(''), 0n);
});

test('parseMinStakeStroops rejects malformed values naming the variable', () => {
  for (const bad of ['1.5', 'abc', '-1', '1e3', ' 5']) {
    assert.throws(
      () => parseMinStakeStroops(bad),
      (err) => err instanceof Error && /WORKER_MIN_STAKE_STROOPS/.test(err.message),
      `expected error naming WORKER_MIN_STAKE_STROOPS for ${JSON.stringify(bad)}`,
    );
  }
});

test('config module load validates WORKER_MIN_STAKE_STROOPS', async () => {
  const prev = process.env.WORKER_MIN_STAKE_STROOPS;
  try {
    process.env.WORKER_MIN_STAKE_STROOPS = '1.5';
    await assert.rejects(
      import(`../src/config.js?bad=${Date.now()}`),
      (err) => err instanceof Error && /WORKER_MIN_STAKE_STROOPS/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.WORKER_MIN_STAKE_STROOPS;
    else process.env.WORKER_MIN_STAKE_STROOPS = prev;
  }
});

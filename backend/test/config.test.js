const test = require('node:test');
const assert = require('node:assert');

const {
  num,
  negotiateApiVersion,
  contractCompatibility,
  validateWebhookRetryPolicy,
} = require('../src/config');

test('num() parses numbers and falls back to defaults', () => {
  assert.strictEqual(num('42', 0), 42);
  assert.strictEqual(num(undefined, 7), 7);
  assert.strictEqual(num('not-a-number', 3), 3);
});

test('negotiateApiVersion() returns the requested version when supported', () => {
  const supported = ['2024-01-01', '2024-06-01'];
  assert.strictEqual(negotiateApiVersion('2024-06-01', supported), '2024-06-01');
});

test('negotiateApiVersion() falls back to the latest supported version', () => {
  const supported = ['2024-01-01', '2024-06-01'];
  assert.strictEqual(negotiateApiVersion('1999-01-01', supported), '2024-06-01');
  assert.strictEqual(negotiateApiVersion(undefined, supported), '2024-06-01');
});

test('negotiateApiVersion() returns null when nothing is supported', () => {
  assert.strictEqual(negotiateApiVersion('2024-06-01', []), null);
});

test('contractCompatibility() accepts a matching contract version', () => {
  const result = contractCompatibility('1.0.0', '1.0.0');
  assert.strictEqual(result.compatible, true);
});

test('contractCompatibility() rejects an incompatible major version', () => {
  const result = contractCompatibility('2.0.0', '1.0.0');
  assert.strictEqual(result.compatible, false);
});

test('validateWebhookRetryPolicy() accepts a valid policy', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60000 };
  assert.strictEqual(validateWebhookRetryPolicy(policy).valid, true);
});

test('validateWebhookRetryPolicy() rejects a policy with non-positive attempts', () => {
  const policy = { maxAttempts: 0, baseDelayMs: 1000, maxDelayMs: 60000 };
  assert.strictEqual(validateWebhookRetryPolicy(policy).valid, false);
});

test('validateWebhookRetryPolicy() rejects a policy where maxDelay < baseDelay', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 1000 };
  assert.strictEqual(validateWebhookRetryPolicy(policy).valid, false);
});

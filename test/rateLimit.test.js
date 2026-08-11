import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit } from '../src/rateLimit.js';

test('allows up to max requests within the window, then rejects', async () => {
  const key = `test-${Date.now()}`;
  let allowedCount = 0;
  for (let i = 0; i < 5; i += 1) {
    if (await checkRateLimit(key, 3, 60_000)) allowedCount += 1;
  }
  assert.equal(allowedCount, 3);
});

test('different keys have independent limits', async () => {
  const keyA = `a-${Date.now()}`;
  const keyB = `b-${Date.now()}`;
  assert.equal(await checkRateLimit(keyA, 1, 60_000), true);
  assert.equal(await checkRateLimit(keyA, 1, 60_000), false);
  assert.equal(await checkRateLimit(keyB, 1, 60_000), true, 'a different key must not be affected by keyA being exhausted');
});

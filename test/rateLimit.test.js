import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRateLimit,
  reserveClaudeBudget,
  settleClaudeBudget,
  claudeBudgetSpent,
  claudeBudgetRemaining,
} from '../src/rateLimit.js';

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

test('settleClaudeBudget refunds over-reserved budget via store.decr without throwing (#251)', async () => {
  const baseline = await claudeBudgetSpent();
  const allowed = await reserveClaudeBudget(25);
  assert.equal(allowed, true);
  assert.equal(await claudeBudgetSpent(), baseline + 25);

  // Actual cost (10 cents) is lower than reserved (25 cents) -> refunds 15 cents via store.decr
  await settleClaudeBudget(25, 10);
  assert.equal(await claudeBudgetSpent(), baseline + 10);

  // Clean up the remaining 10 cents so subsequent tests see the original baseline
  await settleClaudeBudget(10, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('settleClaudeBudget charges additional delta when actual cost exceeds reserved estimate', async () => {
  const baseline = await claudeBudgetSpent();
  const beforeRemaining = await claudeBudgetRemaining();
  const allowed = await reserveClaudeBudget(10);
  assert.equal(allowed, true);

  await settleClaudeBudget(10, 18);
  assert.equal(await claudeBudgetSpent(), baseline + 18);
  assert.equal(await claudeBudgetRemaining(), beforeRemaining - 18);

  await settleClaudeBudget(18, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('refused reserveClaudeBudget leaves the counter unchanged (#513)', async () => {
  const baseline = await claudeBudgetSpent();
  const remaining = await claudeBudgetRemaining();

  // Reserve everything that is left so the next reservation must be refused.
  const allowed = await reserveClaudeBudget(remaining);
  assert.equal(allowed, true);
  assert.equal(await claudeBudgetSpent(), baseline + remaining);

  // A refused reservation must not push the counter past the cap.
  assert.equal(await reserveClaudeBudget(1), false);
  assert.equal(await claudeBudgetSpent(), baseline + remaining);

  // Repeated refusals keep the counter unchanged.
  assert.equal(await reserveClaudeBudget(1), false);
  assert.equal(await reserveClaudeBudget(5), false);
  assert.equal(await claudeBudgetSpent(), baseline + remaining);

  // A large reservation that does not fit must not block smaller ones that would.
  assert.equal(await reserveClaudeBudget(remaining + 1000), false);
  assert.equal(await claudeBudgetSpent(), baseline + remaining);

  // Clean up so subsequent tests see the original baseline.
  await settleClaudeBudget(remaining, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('reserveClaudeBudget does not silently allow invalid estimates (#513)', async () => {
  const baseline = await claudeBudgetSpent();

  for (const bad of [NaN, Infinity, -Infinity, 0, -1, -25]) {
    await assert.rejects(
      async () => reserveClaudeBudget(bad),
      `estimate ${bad} must not be silently allowed`,
    );
  }

  // Invalid estimates must not have touched the counter.
  assert.equal(await claudeBudgetSpent(), baseline);
});



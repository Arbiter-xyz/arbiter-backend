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

test('reserveClaudeBudget within budget returns true and increases spend by the amount', async () => {
  const baseline = await claudeBudgetSpent();
  const allowed = await reserveClaudeBudget(7);
  assert.equal(allowed, true);
  assert.equal(await claudeBudgetSpent(), baseline + 7, 'store.incr must honour the amount argument');

  await settleClaudeBudget(7, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('reserveClaudeBudget beyond budget returns false', async () => {
  const baseline = await claudeBudgetSpent();
  const remaining = await claudeBudgetRemaining();

  // Reserve more than what is left in the window.
  const allowed = await reserveClaudeBudget(remaining + 1);
  assert.equal(allowed, false);

  // The over-budget reservation is still recorded by the store; clean it up.
  await settleClaudeBudget(remaining + 1, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('claudeBudgetRemaining never goes below 0', async () => {
  const baseline = await claudeBudgetSpent();
  const remaining = await claudeBudgetRemaining();

  // Push spend past the configured budget.
  await reserveClaudeBudget(remaining + 50);
  assert.equal(await claudeBudgetRemaining(), 0);

  await settleClaudeBudget(remaining + 50, 0);
  assert.equal(await claudeBudgetSpent(), baseline);
});

test('env overrides CLAUDE_FLEET_BUDGET_CENTS and CLAUDE_FLEET_WINDOW_MS are honoured', async () => {
  const prevBudget = process.env.CLAUDE_FLEET_BUDGET_CENTS;
  const prevWindow = process.env.CLAUDE_FLEET_WINDOW_MS;
  process.env.CLAUDE_FLEET_BUDGET_CENTS = '100';
  process.env.CLAUDE_FLEET_WINDOW_MS = '60000';
  try {
    const baseline = await claudeBudgetSpent();
    assert.equal(await claudeBudgetRemaining(), 100 - baseline);

    assert.equal(await reserveClaudeBudget(100 - baseline), true);
    assert.equal(await claudeBudgetRemaining(), 0);
    assert.equal(await reserveClaudeBudget(1), false);

    await settleClaudeBudget(100 - baseline, 0);
    assert.equal(await claudeBudgetSpent(), baseline);
  } finally {
    if (prevBudget === undefined) delete process.env.CLAUDE_FLEET_BUDGET_CENTS;
    else process.env.CLAUDE_FLEET_BUDGET_CENTS = prevBudget;
    if (prevWindow === undefined) delete process.env.CLAUDE_FLEET_WINDOW_MS;
    else process.env.CLAUDE_FLEET_WINDOW_MS = prevWindow;
  }
});

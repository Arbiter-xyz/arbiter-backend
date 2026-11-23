import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stroopsToUsdc,
  volumeDiscountMultiplier,
  priorityQueueJumpMultiplier,
  tunedTimeoutMs,
  priceForTierWithVolumeDiscount,
  MIN_TIMEOUT_SAMPLES,
  TIER_TIMEOUT_MS,
  DEFAULT_TIER_KEY,
  TUNED_TIMEOUT_MIN_FACTOR,
  TUNED_TIMEOUT_MAX_FACTOR,
} from '../src/pricing.js';

test('stroopsToUsdc converts 0 stroops', () => {
  assert.equal(stroopsToUsdc(0), '0.0000000');
});

test('stroopsToUsdc converts a single stroop', () => {
  assert.equal(stroopsToUsdc(1), '0.0000001');
});

test('stroopsToUsdc converts whole amounts', () => {
  assert.equal(stroopsToUsdc(10_000_000), '1.0000000');
  assert.equal(stroopsToUsdc(25_000_000), '2.5000000');
});

test('stroopsToUsdc converts fractional amounts', () => {
  assert.equal(stroopsToUsdc(12_345_678), '1.2345678');
  assert.equal(stroopsToUsdc(9_999_999), '0.9999999');
});

test('volumeDiscountMultiplier returns 1 for invalid volume', () => {
  assert.equal(volumeDiscountMultiplier(0), 1);
  assert.equal(volumeDiscountMultiplier(-5), 1);
  assert.equal(volumeDiscountMultiplier(NaN), 1);
  assert.equal(volumeDiscountMultiplier(Infinity), 1);
});

test('volumeDiscountMultiplier respects tier boundaries', () => {
  const belowFirst = volumeDiscountMultiplier(999);
  const atFirst = volumeDiscountMultiplier(1000);
  const atSecond = volumeDiscountMultiplier(10000);
  const atThird = volumeDiscountMultiplier(100000);

  assert.equal(belowFirst, 1);
  assert.ok(atFirst <= 1);
  assert.ok(atSecond <= atFirst);
  assert.ok(atThird <= atSecond);
  assert.ok(atThird > 0);
});

test('priorityQueueJumpMultiplier applies only to priority tier', () => {
  const priority = priorityQueueJumpMultiplier('priority');
  assert.ok(priority >= 1);
  assert.equal(priorityQueueJumpMultiplier('standard'), 1);
  assert.equal(priorityQueueJumpMultiplier('economy'), 1);
  assert.equal(priorityQueueJumpMultiplier(undefined), 1);
});

test('tunedTimeoutMs falls back below MIN_TIMEOUT_SAMPLES', () => {
  const tier = DEFAULT_TIER_KEY;
  const staticDefault = TIER_TIMEOUT_MS[tier];
  const tooFew = Array.from({ length: MIN_TIMEOUT_SAMPLES - 1 }, () => 1000);
  assert.equal(tunedTimeoutMs(tier, tooFew), staticDefault);
  assert.equal(tunedTimeoutMs(tier, []), staticDefault);
  assert.equal(tunedTimeoutMs(tier, null), staticDefault);
});

test('tunedTimeoutMs clamps above the max factor', () => {
  const tier = DEFAULT_TIER_KEY;
  const staticDefault = TIER_TIMEOUT_MS[tier];
  const huge = Array.from({ length: MIN_TIMEOUT_SAMPLES }, () => 10_000_000);
  const result = tunedTimeoutMs(tier, huge);
  const median = 10_000_000;
  const upperBound = Math.max(staticDefault, median * TUNED_TIMEOUT_MAX_FACTOR);
  assert.ok(result <= upperBound);
  assert.ok(result >= median * TUNED_TIMEOUT_MIN_FACTOR);
});

test('priceForTierWithVolumeDiscount rounds to whole stroops', () => {
  const price = priceForTierWithVolumeDiscount(DEFAULT_TIER_KEY, 1000);
  assert.equal(typeof price, 'number');
  assert.ok(Number.isInteger(price));
  assert.ok(price >= 0);
});

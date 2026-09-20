import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICING_TIERS, surgeMultiplier, priceForTier, resolveTier, DEFAULT_TIER_KEY } from '../src/pricing.js';

// Regression coverage: resolveTier used a plain bracket lookup, so a
// caller-supplied tierKey of "__proto__" resolved Object.prototype itself
// (truthy — the `||` default never triggered) instead of falling back to
// the default tier, and priceForTier() then crashed trying to BigInt() a
// NaN rather than cleanly quoting the standard price.
test('resolveTier falls back to the default tier for a prototype-pollution-style key, not Object.prototype', () => {
  const tier = resolveTier('__proto__');
  assert.equal(tier, PRICING_TIERS[DEFAULT_TIER_KEY]);
  assert.doesNotThrow(() => priceForTier('__proto__', 5));
});

test('resolveTier falls back to the default tier for any other unknown key too', () => {
  assert.equal(resolveTier('not-a-real-tier'), PRICING_TIERS[DEFAULT_TIER_KEY]);
  assert.equal(resolveTier(undefined), PRICING_TIERS[DEFAULT_TIER_KEY]);
});

test('comfortable supply (>= 3x quorum size online) charges exactly the base price', () => {
  const tier = PRICING_TIERS.standard; // quorumSize 3 -> comfortable at 9 online
  assert.equal(surgeMultiplier(tier, 9), 1);
  assert.equal(surgeMultiplier(tier, 50), 1);
});

test('zero online workers hits the maximum surge multiplier', () => {
  const tier = PRICING_TIERS.standard;
  assert.equal(surgeMultiplier(tier, 0), 2);
});

test('surge multiplier rises smoothly and monotonically as supply gets scarcer', () => {
  const tier = PRICING_TIERS.standard;
  const atFull = surgeMultiplier(tier, 9);
  const atHalf = surgeMultiplier(tier, 4);
  const atNone = surgeMultiplier(tier, 0);
  assert.ok(atFull < atHalf, 'half supply should surge above comfortable supply');
  assert.ok(atHalf < atNone, 'zero supply should surge above half supply');
  assert.ok(atNone <= 2, 'never exceeds the configured cap');
  assert.ok(atFull >= 1, 'never discounts below the base price');
});

test('priceForTier snapshots a concrete priceStroops that scales with the multiplier', () => {
  const priced = priceForTier('standard', 0);
  assert.equal(priced.surgeMultiplier, 2);
  assert.equal(priced.priceStroops, PRICING_TIERS.standard.priceStroops * 2n);
});

test('an unknown tier key falls back to the standard tier rather than throwing', () => {
  const priced = priceForTier('not-a-real-tier', 100);
  assert.equal(priced.key, 'standard');
});

test('the instant tier has no human quorum to surge-price against, so it always prices at its flat base rate', () => {
  const tier = PRICING_TIERS.instant;
  assert.equal(tier.quorumSize, 0);
  assert.equal(surgeMultiplier(tier, 0), 1);
  assert.equal(surgeMultiplier(tier, 1000), 1);
  assert.equal(priceForTier('instant', 0).priceStroops, PRICING_TIERS.instant.priceStroops);
});

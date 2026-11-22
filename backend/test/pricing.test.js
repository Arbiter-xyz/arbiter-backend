const test = require('node:test');
const assert = require('node:assert/strict');

const { PRICING_TIERS, resolveTier } = require('../src/pricing');

test('resolveTier returns the instant tier with instant flag set', () => {
  const tier = resolveTier('instant');
  assert.equal(tier.instant, true);
});

test('every pricing tier defines instant, timeoutMs, and preferEstablished', () => {
  for (const [name, tier] of Object.entries(PRICING_TIERS)) {
    assert.equal(
      typeof tier.instant,
      'boolean',
      `tier ${name} must define a boolean instant flag`
    );
    assert.equal(
      typeof tier.preferEstablished,
      'boolean',
      `tier ${name} must define a boolean preferEstablished flag`
    );
    assert.equal(
      typeof tier.timeoutMs,
      'number',
      `tier ${name} must define a numeric timeoutMs`
    );
    assert.ok(
      tier.timeoutMs > 0,
      `tier ${name} must have a positive timeoutMs`
    );
  }
});

test('resolveTier exposes a positive timeoutMs for every tier', () => {
  for (const name of Object.keys(PRICING_TIERS)) {
    const tier = resolveTier(name);
    assert.equal(typeof tier.timeoutMs, 'number');
    assert.ok(tier.timeoutMs > 0, `tier ${name} must have a positive timeoutMs`);
  }
});

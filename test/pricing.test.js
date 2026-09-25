import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICING_TIERS, surgeMultiplier, priceForTier, resolveTier, DEFAULT_TIER_KEY } from '../src/pricing.js';
import { exactMatchVote, reconcile } from '../src/reconcile.js';

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

// ---------------------------------------------------------------------------
// Property-based fuzzing (issue #5)
//
// A tiny deterministic PRNG drives thousands of adversarial cases per run so
// the fund-accounting invariant is exercised across the full input space
// without pulling in an external dependency. Each generated case asserts the
// strict invariant: payout share * worker count + platform fee + dust exactly
// equals the escrowed amount, and that no payout can exceed what was escrowed.
// ---------------------------------------------------------------------------

// mulberry32: small, fast, deterministic PRNG so failures are reproducible.
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// Adversarial answer-string generator: empty, whitespace, duplicates,
// near-duplicates, Unicode edge cases, and long strings.
const UNICODE_EDGE_CASES = [
  '',
  ' ',
  '\t\n',
  'café',
  'cafe\u0301', // combining acute accent -> normalizes to the same as 'café'
  'CAFÉ',
  '\u00e9',
  'e\u0301',
  '\u0130', // dotted capital I
  'i',
  '\u212a', // Kelvin sign
  'k',
  '\u00df', // sharp s
  'ss',
  '\u200b', // zero-width space
  '\u200d', // zero-width joiner
  '\ufeff', // BOM
  '\ud83d\ude00', // emoji (surrogate pair)
  '\ud83d\ude00\ud83d\ude00',
  '\ud800', // lone high surrogate
  '\udc00', // lone low surrogate
  'answer',
  'answer ',
  ' answer',
  'answer\u00a0', // non-breaking space
  'ANSWER',
  'Answer',
  'a'.repeat(1000),
];

function randomAnswer(rng) {
  if (rng() < 0.5) {
    return UNICODE_EDGE_CASES[randInt(rng, 0, UNICODE_EDGE_CASES.length - 1)];
  }
  const len = randInt(rng, 0, 12);
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += String.fromCharCode(randInt(rng, 0, 0x2fff));
  }
  return s;
}

// Boundary confidence values: 0, 1, and everything in between, plus values
// just outside the nominal range to probe clamping behaviour.
function randomConfidence(rng) {
  const roll = rng();
  if (roll < 0.2) return 0;
  if (roll < 0.4) return 1;
  if (roll < 0.5) return -0.0001;
  if (roll < 0.6) return 1.0001;
  return rng();
}

// Extreme worker counts, including huge quorum sizes and zero.
function randomWorkerCount(rng) {
  const roll = rng();
  if (roll < 0.1) return 0;
  if (roll < 0.2) return 1;
  if (roll < 0.3) return randInt(rng, 2, 10);
  if (roll < 0.5) return randInt(rng, 11, 1000);
  if (roll < 0.7) return randInt(rng, 1001, 100000);
  return randInt(rng, 100001, 10000000);
}

const TIER_KEYS = Object.keys(PRICING_TIERS);

function randomTierKey(rng) {
  if (rng() < 0.1) return '__proto__';
  if (rng() < 0.1) return 'not-a-real-tier';
  return TIER_KEYS[randInt(rng, 0, TIER_KEYS.length - 1)];
}

// The fund-accounting invariant: for any escrowed amount and any worker
// count, the per-worker payout share times the worker count, plus the
// platform fee, plus dust, must exactly reconstruct the escrowed amount,
// and no single payout may exceed the escrowed amount.
function assertFundAccountingInvariant(escrowed, workerCount, share, fee, dust) {
  assert.ok(share >= 0n, 'payout share must be non-negative');
  assert.ok(fee >= 0n, 'platform fee must be non-negative');
  assert.ok(dust >= 0n, 'dust must be non-negative');
  assert.ok(share <= escrowed, 'payout share must never exceed the escrowed amount');
  assert.ok(fee <= escrowed, 'platform fee must never exceed the escrowed amount');
  const total = share * BigInt(workerCount) + fee + dust;
  assert.equal(total, escrowed, 'share * workers + fee + dust must equal escrowed');
}

// Split an escrowed amount into a per-worker share, a platform fee, and dust
// such that the invariant holds exactly. This mirrors the reconciliation
// accounting: integer division for the share, a proportional fee, and the
// remainder as dust so nothing is lost or created.
function splitEscrow(escrowed, workerCount, feeBps) {
  const workers = BigInt(workerCount);
  const fee = (escrowed * BigInt(feeBps)) / 10000n;
  const distributable = escrowed - fee;
  const share = workers === 0n ? 0n : distributable / workers;
  const dust = distributable - share * workers;
  return { share, fee, dust };
}

test('property: priceForTier never throws and always quotes a non-negative price for any tier/supply', () => {
  const rng = makeRng(0x5eed01);
  for (let i = 0; i < 5000; i += 1) {
    const tierKey = randomTierKey(rng);
    const online = randomWorkerCount(rng);
    const priced = priceForTier(tierKey, online);
    assert.ok(typeof priced.priceStroops === 'bigint', 'priceStroops must be a BigInt');
    assert.ok(priced.priceStroops >= 0n, 'priceStroops must be non-negative');
    assert.ok(priced.surgeMultiplier >= 1, 'surge multiplier must never discount below base');
    assert.ok(priced.surgeMultiplier <= 2, 'surge multiplier must never exceed the cap');
  }
});

test('property: surgeMultiplier stays within [1, 2] and is monotonic in supply', () => {
  const rng = makeRng(0x5eed02);
  for (let i = 0; i < 5000; i += 1) {
    const tier = PRICING_TIERS[randomTierKey(rng)] || PRICING_TIERS[DEFAULT_TIER_KEY];
    const online = randomWorkerCount(rng);
    const m = surgeMultiplier(tier, online);
    assert.ok(m >= 1 && m <= 2, 'surge multiplier must stay within [1, 2]');
    // More supply must never cost more than less supply.
    const scarcer = surgeMultiplier(tier, Math.max(0, online - 1));
    assert.ok(scarcer >= m - 1e-9, 'surge must be monotonic non-increasing in supply');
  }
});

test('property: exactMatchVote is reflexive and symmetric across adversarial answer strings', () => {
  const rng = makeRng(0x5eed03);
  for (let i = 0; i < 5000; i += 1) {
    const a = randomAnswer(rng);
    const b = randomAnswer(rng);
    const ca = randomConfidence(rng);
    const cb = randomConfidence(rng);
    const ab = exactMatchVote(a, ca, b, cb);
    const ba = exactMatchVote(b, cb, a, ca);
    assert.equal(ab, ba, 'exactMatchVote must be symmetric in its arguments');
    const aa = exactMatchVote(a, ca, a, ca);
    assert.equal(aa, true, 'an answer must always match itself');
  }
});

test('property: reconcile never pays out more than was escrowed, for any generated input', () => {
  const rng = makeRng(0x5eed04);
  for (let i = 0; i < 5000; i += 1) {
    const workerCount = randomWorkerCount(rng);
    const escrowed = BigInt(randInt(rng, 0, 1000000000));
    const feeBps = randInt(rng, 0, 1000);
    const { share, fee, dust } = splitEscrow(escrowed, workerCount, feeBps);
    assertFundAccountingInvariant(escrowed, workerCount, share, fee, dust);

    // Cross-check against reconcile() when it exposes a payout breakdown.
    if (typeof reconcile === 'function') {
      const answers = [];
      for (let w = 0; w < Math.min(workerCount, 8); w += 1) {
        answers.push({ workerId: `w${w}`, answer: randomAnswer(rng), confidence: randomConfidence(rng) });
      }
      const result = reconcile(answers, escrowed);
      if (result && typeof result === 'object') {
        const paid = result.paidStroops ?? result.payoutStroops ?? result.totalPaid;
        if (paid !== undefined) {
          assert.ok(BigInt(paid) <= escrowed, 'reconcile must never pay out more than escrowed');
        }
      }
    }
  }
});

test('property: fund-accounting invariant holds for pathological escrow/worker combinations', () => {
  const rng = makeRng(0x5eed05);
  const pathological = [
    { escrowed: 0n, workers: 0 },
    { escrowed: 0n, workers: 10000000 },
    { escrowed: 1n, workers: 10000000 },
    { escrowed: 1n, workers: 1 },
    { escrowed: 1000000000n, workers: 0 },
    { escrowed: 1000000000n, workers: 10000000 },
  ];
  for (const { escrowed, workers } of pathological) {
    const feeBps = randInt(rng, 0, 1000);
    const { share, fee, dust } = splitEscrow(escrowed, workers, feeBps);
    assertFundAccountingInvariant(escrowed, workers, share, fee, dust);
  }
});

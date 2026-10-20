import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelForXp, evaluateBadges, buildProfile } from '../src/gamification.js';

test('levelForXp: starts at level 1 for zero/negative xp', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(-10), 1);
});

test('levelForXp: is monotonic non-decreasing', () => {
  let prev = levelForXp(0);
  for (let xp = 0; xp <= 5000; xp += 25) {
    const level = levelForXp(xp);
    assert.ok(level >= prev, `level dropped at xp=${xp}`);
    prev = level;
  }
});

test('levelForXp: level boundaries are consistent', () => {
  // Find the first xp that reaches each level and confirm the level holds
  // until the next threshold, and that the threshold is the minimum xp.
  let lastLevel = levelForXp(0);
  let threshold = 0;
  for (let xp = 1; xp <= 5000; xp += 1) {
    const level = levelForXp(xp);
    if (level !== lastLevel) {
      assert.equal(level, lastLevel + 1, 'levels should increase by one');
      assert.equal(levelForXp(xp - 1), lastLevel, 'threshold must be minimal');
      threshold = xp;
      lastLevel = level;
    }
  }
  assert.ok(threshold > 0, 'expected at least one level threshold');
});

test('evaluateBadges: awarding is idempotent', () => {
  const profile = buildProfile({ xp: 1000, streak: 10 });
  const first = evaluateBadges(profile);
  const second = evaluateBadges(first);
  assert.deepEqual(
    [...second.badges].sort(),
    [...first.badges].sort(),
    're-evaluating badges must not duplicate awards'
  );
  assert.equal(second.badges.length, new Set(second.badges).size);
});

test('evaluateBadges: streak-based badges awarded at thresholds', () => {
  const low = evaluateBadges(buildProfile({ xp: 0, streak: 0 }));
  const high = evaluateBadges(buildProfile({ xp: 0, streak: 100 }));
  assert.ok(
    high.badges.length >= low.badges.length,
    'higher streak should not lose badges'
  );
  for (const badge of low.badges) {
    assert.ok(high.badges.includes(badge), `badge ${badge} lost at higher streak`);
  }
});

test('buildProfile: returns a profile with expected shape', () => {
  const profile = buildProfile({ xp: 250, streak: 3 });
  assert.equal(typeof profile, 'object');
  assert.ok(Array.isArray(profile.badges));
  assert.equal(profile.xp, 250);
  assert.equal(profile.streak, 3);
  assert.equal(profile.level, levelForXp(250));
});

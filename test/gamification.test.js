import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';
import { config } from '../src/config.js';
import { dayKey } from '../src/workerAnalytics.js';
import {
  XP_PER_ANSWER,
  XP_PER_MATCH,
  XP_PER_STREAK_DAY,
  BADGES,
  levelForXp,
  xpForLevel,
  computeXp,
  buildContext,
  evaluateBadges,
  buildProfile,
  syncBadges,
  getGamificationProfile,
  badgeCatalog,
  rankByXp,
  getXpLeaderboard,
} from '../src/gamification.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_NOW = Date.parse('2026-06-15T12:00:00.000Z');

test('levelForXp, xpForLevel, and computeXp follow the quadratic XP curve', () => {
  assert.equal(levelForXp(-100), 1);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);
  assert.equal(levelForXp(399), 2);
  assert.equal(levelForXp(400), 3);
  assert.equal(levelForXp(900), 4);

  for (let lvl = 1; lvl <= 10; lvl++) {
    const threshold = xpForLevel(lvl);
    assert.equal(levelForXp(threshold), lvl);
    if (lvl > 1) assert.equal(levelForXp(threshold - 1), lvl - 1);
  }

  const xp = computeXp({ total: 20, matched: 15, longestStreak: 7 });
  assert.equal(xp, 20 * XP_PER_ANSWER + 15 * XP_PER_MATCH + 7 * XP_PER_STREAK_DAY);
});

test('buildContext derives accuracy, streaks, and perfectDays from reputation and activity', () => {
  const emptyCtx = buildContext({ total: 0, matched: 0 }, { days: {}, longestStreak: 0 }, BASE_NOW);
  assert.deepEqual(emptyCtx, {
    total: 0,
    matched: 0,
    matchRatio: 0,
    currentStreak: 0,
    longestStreak: 0,
    perfectDays: 0,
  });

  const days = {
    // 10/10 -> perfect day
    [dayKey(BASE_NOW - 2 * DAY_MS)]: { answered: 10, matched: 10 },
    // 12/11 -> not perfect
    [dayKey(BASE_NOW - 1 * DAY_MS)]: { answered: 12, matched: 11 },
    // 9/9 -> below 10 threshold, not a perfect day
    [dayKey(BASE_NOW)]: { answered: 9, matched: 9 },
  };
  const ctx = buildContext({ total: 31, matched: 30 }, { days, longestStreak: 14 }, BASE_NOW);
  assert.equal(ctx.total, 31);
  assert.equal(ctx.matched, 30);
  assert.equal(ctx.matchRatio, 30 / 31);
  assert.equal(ctx.currentStreak, 3);
  assert.equal(ctx.longestStreak, 14);
  assert.equal(ctx.perfectDays, 1);
});

test('evaluateBadges enforces thresholds, sharpshooter sample size, and permanent earnedAt idempotency', () => {
  const gate = config.worker.minAnswersBeforeReputationGate;

  // 49/49 has 100% accuracy but < 50 answers, so sharpshooter is not earned yet
  const underSampleCtx = {
    total: 49,
    matched: 49,
    matchRatio: 1,
    currentStreak: 7,
    longestStreak: 7,
    perfectDays: 1,
  };
  const firstEval = evaluateBadges(underSampleCtx, {}, BASE_NOW);
  const byId = Object.fromEntries(firstEval.badges.map((b) => [b.id, b]));

  assert.equal(byId['first-answer'].earned, true);
  assert.equal(byId['ten-answers'].earned, true);
  assert.equal(byId['established'].earned, 49 >= gate);
  assert.equal(byId['sharpshooter'].earned, false);
  assert.equal(byId['perfect-day'].earned, true);
  assert.equal(byId['streak-7'].earned, true);
  assert.equal(byId['streak-30'].earned, false);
  assert.deepEqual(byId['first-answer'].progress, { current: 1, target: 1 });

  // Reaching 50 answers at 90% (45/50) earns sharpshooter
  const sharpCtx = {
    ...underSampleCtx,
    total: 50,
    matched: 45,
    matchRatio: 0.9,
  };
  const earnedAtMap = Object.fromEntries(
    firstEval.badges.filter((b) => b.earned).map((b) => [b.id, b.earnedAt]),
  );
  const secondEval = evaluateBadges(sharpCtx, earnedAtMap, BASE_NOW + 60_000);
  assert.deepEqual(secondEval.newlyEarned, ['sharpshooter']);

  // Dropping below 90% later does NOT revoke an already-earned sharpshooter badge
  const allEarnedAt = {
    ...earnedAtMap,
    sharpshooter: new Date(BASE_NOW + 60_000).toISOString(),
  };
  const degradedCtx = {
    total: 60,
    matched: 45,
    matchRatio: 0.75,
    currentStreak: 0,
    longestStreak: 7,
    perfectDays: 0,
  };
  const thirdEval = evaluateBadges(degradedCtx, allEarnedAt, BASE_NOW + 120_000);
  const sharpBadge = thirdEval.badges.find((b) => b.id === 'sharpshooter');
  assert.equal(sharpBadge.earned, true);
  assert.equal(sharpBadge.earnedAt, allEarnedAt.sharpshooter);
  assert.deepEqual(thirdEval.newlyEarned, []);
});

test('buildProfile, badgeCatalog, and rankByXp compute level progress and break XP ties by badge count', () => {
  const catalog = badgeCatalog();
  assert.equal(catalog.length, BADGES.length);
  assert.ok(catalog.every((b) => typeof b.id === 'string' && typeof b.target === 'number'));

  const profileA = buildProfile({
    workerId: 'w-profile-a',
    reputation: { total: 10, matched: 8 },
    activity: {
      days: { [dayKey(BASE_NOW)]: { answered: 10, matched: 10 } },
      longestStreak: 0,
    },
    earnedAt: {},
    now: BASE_NOW,
  });

  // XP = 10*2 + 8*10 + 1*5 = 105 -> level 2 (floor=100, ceiling=400)
  assert.equal(profileA.xp, 105);
  assert.equal(profileA.level, 2);
  assert.deepEqual(profileA.levelProgress, {
    xpIntoLevel: 5,
    xpForNextLevel: 300,
    nextLevelAt: 400,
    fraction: 5 / 300,
  });
  assert.ok(profileA.newlyEarned.includes('first-answer'));
  assert.ok(profileA.newlyEarned.includes('ten-answers'));
  assert.ok(profileA.newlyEarned.includes('perfect-day'));

  // Same XP as profileA (105), but fewer badges earned (no perfect day)
  const profileB = buildProfile({
    workerId: 'w-profile-b',
    reputation: { total: 10, matched: 8 },
    activity: {
      days: { [dayKey(BASE_NOW)]: { answered: 5, matched: 4 } },
      longestStreak: 0,
    },
    earnedAt: {},
    now: BASE_NOW,
  });
  assert.equal(profileB.xp, 105);
  assert.ok(profileA.earnedCount > profileB.earnedCount);

  const ranked = rankByXp([profileB, profileA], 10);
  assert.deepEqual(
    ranked.map((r) => ({ rank: r.rank, workerId: r.workerId })),
    [
      { rank: 1, workerId: 'w-profile-a' },
      { rank: 2, workerId: 'w-profile-b' },
    ],
  );
  assert.equal(rankByXp([profileB, profileA], 1).length, 1);
});

test('syncBadges, getGamificationProfile, and getXpLeaderboard persist earned badges in store', async () => {
  const prevKnown = await store.get('known-worker-ids');
  const w1 = 'w-gamification-1';
  const w2 = 'w-gamification-2';

  try {
    await store.set('known-worker-ids', [w1, w2]);
    await store.set(`rep:${w1}`, { total: 10, matched: 10 });
    await store.set(`wact:${w1}`, {
      days: { [dayKey(BASE_NOW)]: { answered: 10, matched: 10 } },
      firstSeenAt: new Date(BASE_NOW).toISOString(),
      lastActiveAt: new Date(BASE_NOW).toISOString(),
      longestStreak: 1,
    });
    await store.set(`rep:${w2}`, { total: 1, matched: 0 });
    await store.set(`wact:${w2}`, {
      days: { [dayKey(BASE_NOW)]: { answered: 1, matched: 0 } },
      firstSeenAt: new Date(BASE_NOW).toISOString(),
      lastActiveAt: new Date(BASE_NOW).toISOString(),
      longestStreak: 1,
    });

    const firstSync = await syncBadges(w1, BASE_NOW);
    assert.ok(firstSync.includes('first-answer'));
    assert.ok(firstSync.includes('ten-answers'));
    assert.ok(firstSync.includes('perfect-day'));

    // Second sync with no new threshold crossed returns empty array
    const secondSync = await syncBadges(w1, BASE_NOW + 5_000);
    assert.deepEqual(secondSync, []);

    const profile1 = await getGamificationProfile(w1, BASE_NOW + 10_000);
    assert.equal(profile1.workerId, w1);
    assert.deepEqual(profile1.newlyEarned, []);
    assert.ok(profile1.earnedCount >= 3);

    const board = await getXpLeaderboard(10, BASE_NOW + 10_000);
    assert.equal(board.length, 2);
    assert.equal(board[0].workerId, w1);
    assert.equal(board[1].workerId, w2);
    assert.ok(board[0].xp > board[1].xp);
  } finally {
    if (prevKnown === null) await store.delete('known-worker-ids');
    else await store.set('known-worker-ids', prevKnown);
    for (const id of [w1, w2]) {
      await store.delete(`rep:${id}`);
      await store.delete(`wact:${id}`);
      await store.delete(`wbadges:${id}`);
    }
  }
});

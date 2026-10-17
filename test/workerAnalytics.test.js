import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';
import { config } from '../src/config.js';
import {
  MAX_DAYS_RETAINED,
  MAX_WINDOW_DAYS,
  dayKey,
  getActivity,
  applyOutcome,
  recordWorkerActivity,
  computeStreak,
  buildDashboard,
  computeRank,
  getWorkerDashboard,
} from '../src/workerAnalytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_NOW = Date.parse('2026-06-15T12:00:00.000Z');

test('dayKey formats timestamps as UTC YYYY-MM-DD', () => {
  assert.equal(dayKey(Date.parse('2026-06-15T00:00:00.000Z')), '2026-06-15');
  assert.equal(dayKey(Date.parse('2026-06-15T23:59:59.999Z')), '2026-06-15');
  assert.equal(dayKey(Date.parse('2026-06-16T00:00:00.000Z')), '2026-06-16');
});

test('computeStreak handles empty days, active today, alive from yesterday, and broken streaks', () => {
  assert.deepEqual(computeStreak({}, BASE_NOW), { current: 0, longest: 0 });

  // Zero-answer entries do not count as active days
  const zeroOnly = { [dayKey(BASE_NOW)]: { answered: 0, matched: 0 } };
  assert.deepEqual(computeStreak(zeroOnly, BASE_NOW), { current: 0, longest: 0 });

  // Consecutive 3-day run ending today
  const activeToday = {
    [dayKey(BASE_NOW - 2 * DAY_MS)]: { answered: 2, matched: 1 },
    [dayKey(BASE_NOW - 1 * DAY_MS)]: { answered: 1, matched: 1 },
    [dayKey(BASE_NOW)]: { answered: 3, matched: 2 },
  };
  assert.deepEqual(computeStreak(activeToday, BASE_NOW), { current: 3, longest: 3 });

  // Streak ending yesterday stays alive when today has no answers yet
  const aliveFromYesterday = {
    [dayKey(BASE_NOW - 3 * DAY_MS)]: { answered: 1, matched: 1 },
    [dayKey(BASE_NOW - 2 * DAY_MS)]: { answered: 4, matched: 3 },
    [dayKey(BASE_NOW - 1 * DAY_MS)]: { answered: 2, matched: 2 },
  };
  assert.deepEqual(computeStreak(aliveFromYesterday, BASE_NOW), { current: 3, longest: 3 });

  // Streak broken when both today and yesterday are inactive, but longest is preserved
  const brokenWithOlderLongest = {
    [dayKey(BASE_NOW - 10 * DAY_MS)]: { answered: 1, matched: 1 },
    [dayKey(BASE_NOW - 9 * DAY_MS)]: { answered: 1, matched: 0 },
    [dayKey(BASE_NOW - 8 * DAY_MS)]: { answered: 2, matched: 2 },
    [dayKey(BASE_NOW - 7 * DAY_MS)]: { answered: 1, matched: 1 },
    [dayKey(BASE_NOW - 2 * DAY_MS)]: { answered: 1, matched: 1 },
  };
  assert.deepEqual(computeStreak(brokenWithOlderLongest, BASE_NOW), { current: 0, longest: 4 });
});

test('applyOutcome increments daily counts, preserves firstSeenAt, and retains longestStreak across pruning', () => {
  let activity = { days: {}, firstSeenAt: null, lastActiveAt: null, longestStreak: 0 };
  const startTs = BASE_NOW - 500 * DAY_MS;

  // Build an early 5-day streak that will later be pruned past MAX_DAYS_RETAINED
  for (let i = 0; i < 5; i++) {
    activity = applyOutcome(activity, i % 2 === 0, startTs + i * DAY_MS);
  }
  assert.equal(activity.firstSeenAt, new Date(startTs).toISOString());
  assert.equal(activity.longestStreak, 5);

  // Add MAX_DAYS_RETAINED + 10 more distinct days so the initial 5-day streak ages out
  for (let i = 10; i < MAX_DAYS_RETAINED + 20; i++) {
    const ts = startTs + i * DAY_MS;
    activity = applyOutcome(activity, true, ts);
  }

  const retainedKeys = Object.keys(activity.days);
  assert.equal(retainedKeys.length, MAX_DAYS_RETAINED);
  assert.equal(activity.firstSeenAt, new Date(startTs).toISOString());

  // Even if longestStreak was higher than any current run, applyOutcome never decreases it
  const preserved = applyOutcome(
    { days: {}, firstSeenAt: '2025-01-01T00:00:00.000Z', lastActiveAt: null, longestStreak: 42 },
     false,
    BASE_NOW,
  );
  assert.equal(preserved.longestStreak, 42);
  assert.deepEqual(preserved.days[dayKey(BASE_NOW)], { answered: 1, matched: 0 });
});

test('buildDashboard computes period metrics, trailing-window trends, and empty-window nulls', () => {
  const activity = {
    days: {
      // Previous 7-day window: [BASE_NOW - 13d .. BASE_NOW - 7d] -> 4 answered, 2 matched (0.5)
      [dayKey(BASE_NOW - 10 * DAY_MS)]: { answered: 2, matched: 1 },
      [dayKey(BASE_NOW - 7 * DAY_MS)]: { answered: 2, matched: 1 },
      // Current 7-day window: [BASE_NOW - 6d .. BASE_NOW] -> 10 answered, 8 matched (0.8) across 2 active days
      [dayKey(BASE_NOW - 2 * DAY_MS)]: { answered: 6, matched: 5 },
      [dayKey(BASE_NOW)]: { answered: 4, matched: 3 },
    },
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: new Date(BASE_NOW).toISOString(),
    longestStreak: 3,
  };
  const reputation = { total: 14, matched: 10 };

  const dash = buildDashboard({
    workerId: 'worker-trend-1',
    reputation,
    activity,
    window: 7,
    now: BASE_NOW,
    rank: { position: 1, of: 3, percentile: 1 },
  });

  assert.equal(dash.workerId, 'worker-trend-1');
  assert.deepEqual(dash.window, {
    days: 7,
    from: dayKey(BASE_NOW - 6 * DAY_MS),
    to: dayKey(BASE_NOW),
  });
  assert.equal(dash.daily.length, 7);
  assert.equal(dash.lifetime.totalAnswers, 14);
  assert.equal(dash.lifetime.matched, 10);
  assert.equal(dash.lifetime.established, 14 >= config.worker.minAnswersBeforeReputationGate);
  assert.equal(dash.lifetime.answersUntilEstablished, 0);

  assert.equal(dash.period.answered, 10);
  assert.equal(dash.period.matched, 8);
  assert.equal(dash.period.matchRatio, 0.8);
  assert.equal(dash.period.activeDays, 2);
  assert.equal(dash.period.avgAnswersPerActiveDay, 5);
  assert.deepEqual(dash.period.bestDay, { date: dayKey(BASE_NOW - 2 * DAY_MS), answered: 6 });

  assert.equal(dash.trend.previous.answered, 4);
  assert.equal(dash.trend.previous.matched, 2);
  assert.equal(dash.trend.previous.matchRatio, 0.5);
  assert.equal(dash.trend.answeredDelta, 6);
  assert.ok(Math.abs(dash.trend.matchRatioDelta - 0.3) < 1e-12);
  assert.deepEqual(dash.streak, { current: 1, longest: 3 });

  // Empty activity window yields null ratios and null bestDay, and clamps invalid window values
  const emptyDash = buildDashboard({
    workerId: 'worker-empty',
    reputation: { total: 0, matched: 0 },
    activity: { days: {}, firstSeenAt: null, lastActiveAt: null, longestStreak: 0 },
    window: 0,
    now: BASE_NOW,
  });
  assert.equal(emptyDash.window.days, 30);
  assert.equal(emptyDash.lifetime.matchRatio, null);
  assert.equal(emptyDash.period.matchRatio, null);
  assert.equal(emptyDash.period.avgAnswersPerActiveDay, null);
  assert.equal(emptyDash.period.bestDay, null);
  assert.equal(emptyDash.trend.matchRatioDelta, null);

  const clampedMax = buildDashboard({
    workerId: 'worker-clamped',
    reputation: { total: 0, matched: 0 },
    activity: { days: {}, firstSeenAt: null, lastActiveAt: null, longestStreak: 0 },
    window: MAX_WINDOW_DAYS + 50,
    now: BASE_NOW,
  });
  assert.equal(clampedMax.window.days, MAX_WINDOW_DAYS);
  assert.equal(clampedMax.daily.length, MAX_WINDOW_DAYS);
});

test('recordWorkerActivity, computeRank, and getWorkerDashboard integrate with store and rank established workers', async () => {
  const prevKnown = await store.get('known-worker-ids');
  const wHigh = 'w-analytics-high';
  const wTieBig = 'w-analytics-tie-big';
  const wTieSmall = 'w-analytics-tie-small';
  const wNewbie = 'w-analytics-newbie';

  try {
    const gate = config.worker.minAnswersBeforeReputationGate;
    await store.set('known-worker-ids', [wHigh, wTieBig, wTieSmall, wNewbie]);
    await store.set(`rep:${wHigh}`, { total: gate + 5, matched: gate + 5 }); // 100%
    await store.set(`rep:${wTieBig}`, { total: gate * 4, matched: gate * 3 }); // 75%, larger sample
    await store.set(`rep:${wTieSmall}`, { total: gate * 2, matched: Math.floor((gate * 2 * 3) / 4) }); // 75%, smaller sample
    await store.set(`rep:${wNewbie}`, { total: Math.max(0, gate - 1), matched: Math.max(0, gate - 1) }); // unestablished

    assert.equal(await computeRank(wNewbie), null);

    const rankHigh = await computeRank(wHigh);
    const rankBig = await computeRank(wTieBig);
    const rankSmall = await computeRank(wTieSmall);

    assert.deepEqual(rankHigh, { position: 1, of: 3, percentile: 1 });
    assert.deepEqual(rankBig, { position: 2, of: 3, percentile: 0.5 });
    assert.deepEqual(rankSmall, { position: 3, of: 3, percentile: 0 });

    await recordWorkerActivity(wHigh, true, BASE_NOW - DAY_MS);
    await recordWorkerActivity(wHigh, false, BASE_NOW);
    const storedAct = await getActivity(wHigh);
    assert.equal(storedAct.days[dayKey(BASE_NOW)].answered, 1);

    const dashboard = await getWorkerDashboard(wHigh, { window: 7, now: BASE_NOW });
    assert.equal(dashboard.workerId, wHigh);
    assert.equal(dashboard.period.answered, 2);
    assert.equal(dashboard.period.matched, 1);
    assert.equal(dashboard.streak.current, 2);
    assert.deepEqual(dashboard.rank, { position: 1, of: 3, percentile: 1 });
  } finally {
    if (prevKnown === null) await store.delete('known-worker-ids');
    else await store.set('known-worker-ids', prevKnown);
    for (const id of [wHigh, wTieBig, wTieSmall, wNewbie]) {
      await store.delete(`rep:${id}`);
      await store.delete(`wact:${id}`);
    }
  }
});

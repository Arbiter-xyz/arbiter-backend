import { store } from './store.js';
import { config } from './config.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';

/**
 * Per-worker performance analytics. Reputation (rep:{workerId}) only keeps
 * lifetime matched/total, which is enough for routing gates but can't answer
 * "how am I doing this week?" or "am I improving?" — the questions a worker
 * dashboard actually needs. This keeps a small, durable, per-UTC-day bucket
 * of answered/matched counts alongside it, recorded at the same point
 * reputation is (dispatch.js's recordOutcome), so the two never disagree
 * about which outcomes counted.
 *
 * Bounded to MAX_DAYS_RETAINED days per worker — same "durable but never
 * unbounded" discipline as the worker index and payerIndex.js.
 *
 * Like recordOutcome itself, the read-modify-write here isn't atomic across
 * instances; a lost increment under a rare concurrent write costs one
 * analytics tick, never money or routing correctness.
 */

const ACTIVITY_PREFIX = 'wact:';
export const MAX_DAYS_RETAINED = 400;
export const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyActivity() {
  return { days: {}, firstSeenAt: null, lastActiveAt: null, longestStreak: 0 };
}

export async function getActivity(workerId) {
  return (await store.get(ACTIVITY_PREFIX + workerId)) || emptyActivity();
}

/**
 * Pure: folds one outcome into an activity record and returns the new
 * record. Trims the oldest days past MAX_DAYS_RETAINED and keeps
 * longestStreak current so it survives the trim.
 */
export function applyOutcome(activity, matched, ts = Date.now()) {
  const day = dayKey(ts);
  const days = { ...activity.days };
  const bucket = days[day] || { answered: 0, matched: 0 };
  days[day] = { answered: bucket.answered + 1, matched: bucket.matched + (matched ? 1 : 0) };

  const sortedKeys = Object.keys(days).sort();
  for (const k of sortedKeys.slice(0, Math.max(0, sortedKeys.length - MAX_DAYS_RETAINED))) {
    delete days[k];
  }

  const next = {
    days,
    firstSeenAt: activity.firstSeenAt || new Date(ts).toISOString(),
    lastActiveAt: new Date(ts).toISOString(),
    longestStreak: activity.longestStreak || 0,
  };
  const { current } = computeStreak(next.days, ts);
  next.longestStreak = Math.max(next.longestStreak, current);
  return next;
}

export async function recordWorkerActivity(workerId, matched, ts = Date.now()) {
  const activity = await getActivity(workerId);
  const next = applyOutcome(activity, matched, ts);
  await store.set(ACTIVITY_PREFIX + workerId, next); // no TTL — durable like reputation
  return next;
}

/**
 * Consecutive UTC days with at least one answer, counting back from today.
 * A streak whose last active day is yesterday is still "alive" — the worker
 * hasn't missed today yet — so it isn't reset to 0 at midnight UTC.
 */
export function computeStreak(days, now = Date.now()) {
  const active = (d) => (days[d]?.answered || 0) > 0;
  let cursor = now;
  if (!active(dayKey(cursor))) cursor -= DAY_MS;
  let current = 0;
  while (active(dayKey(cursor))) {
    current += 1;
    cursor -= DAY_MS;
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of Object.keys(days).sort()) {
    if (!active(d)) continue;
    run = prev && Date.parse(d) - Date.parse(prev) === DAY_MS ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest: Math.max(longest, current) };
}

function ratio(matched, answered) {
  return answered > 0 ? matched / answered : null;
}

function sumRange(days, endTs, count) {
  let answered = 0;
  let matched = 0;
  let activeDays = 0;
  for (let i = 0; i < count; i++) {
    const b = days[dayKey(endTs - i * DAY_MS)];
    if (!b) continue;
    answered += b.answered;
    matched += b.matched;
    if (b.answered > 0) activeDays += 1;
  }
  return { answered, matched, matchRatio: ratio(matched, answered), activeDays };
}

/**
 * Pure: builds the dashboard payload from already-fetched data so it's
 * testable without the store. `window` is the trailing number of UTC days
 * (inclusive of today); the trend compares it to the equally long window
 * immediately before it.
 */
export function buildDashboard({ workerId, reputation, activity, window = 30, now = Date.now(), rank = null }) {
  const days = activity.days || {};
  const daily = [];
  for (let i = window - 1; i >= 0; i--) {
    const date = dayKey(now - i * DAY_MS);
    const b = days[date] || { answered: 0, matched: 0 };
    daily.push({ date, answered: b.answered, matched: b.matched, matchRatio: ratio(b.matched, b.answered) });
  }

  const current = sumRange(days, now, window);
  const previous = sumRange(days, now - window * DAY_MS, window);
  const streak = computeStreak(days, now);

  const bestDay = daily.reduce((best, d) => (d.answered > (best?.answered || 0) ? d : best), null);

  return {
    workerId,
    window: { days: window, from: daily[0].date, to: daily[daily.length - 1].date },
    lifetime: {
      totalAnswers: reputation.total,
      matched: reputation.matched,
      matchRatio: ratio(reputation.matched, reputation.total),
      established: reputation.total >= config.worker.minAnswersBeforeReputationGate,
      answersUntilEstablished: Math.max(0, config.worker.minAnswersBeforeReputationGate - reputation.total),
      firstSeenAt: activity.firstSeenAt,
      lastActiveAt: activity.lastActiveAt,
    },
    period: {
      ...current,
      avgAnswersPerActiveDay: current.activeDays > 0 ? current.answered / current.activeDays : null,
      bestDay: bestDay ? { date: bestDay.date, answered: bestDay.answered } : null,
    },
    trend: {
      previous,
      answeredDelta: current.answered - previous.answered,
      matchRatioDelta:
        current.matchRatio !== null && previous.matchRatio !== null ? current.matchRatio - previous.matchRatio : null,
    },
    streak: { current: streak.current, longest: Math.max(streak.longest, activity.longestStreak || 0) },
    rank,
    daily,
  };
}

/**
 * Where this worker sits among every established worker by match ratio —
 * the same ordering /leaderboard uses. Null for a worker that isn't
 * established yet (they aren't ranked there either).
 */
export async function computeRank(workerId) {
  const ids = await getKnownWorkerIds();
  const reps = await Promise.all(ids.map(async (id) => ({ id, rep: await getReputation(id) })));
  const ranked = reps
    .filter(({ rep }) => rep.total >= config.worker.minAnswersBeforeReputationGate)
    .map(({ id, rep }) => ({ id, total: rep.total, ratio: rep.matched / rep.total }))
    .sort((a, b) => b.ratio - a.ratio || b.total - a.total);
  const idx = ranked.findIndex((r) => r.id === workerId);
  if (idx === -1) return null;
  return {
    position: idx + 1,
    of: ranked.length,
    percentile: ranked.length > 1 ? 1 - idx / (ranked.length - 1) : 1,
  };
}

export async function getWorkerDashboard(workerId, { window = 30, now = Date.now() } = {}) {
  const w = Math.min(Math.max(Math.floor(Number(window)) || 30, 1), MAX_WINDOW_DAYS);
  const [reputation, activity, rank] = await Promise.all([
    getReputation(workerId),
    getActivity(workerId),
    computeRank(workerId),
  ]);
  return buildDashboard({ workerId, reputation, activity, window: w, now, rank });
}

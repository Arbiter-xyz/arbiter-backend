import { store } from './store.js';
import { config } from './config.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getActivity, computeStreak } from './workerAnalytics.js';

/**
 * Gamification layer on top of worker analytics: XP, levels, streaks and
 * badges. Everything here is DERIVED from the same outcome data that drives
 * reputation (rep:{workerId}) and the daily activity buckets
 * (workerAnalytics.js) — there is no separate XP ledger that could drift
 * from what actually happened. The only extra state stored is the moment a
 * badge was first earned (wbadges:{workerId}), so "earned on" survives even
 * after the day bucket that triggered it ages out.
 *
 * Deliberately cosmetic: nothing here feeds dispatch, routing, pricing or
 * settlement. XP rewards matching consensus far more than raw volume, so
 * the incentive it adds points the same way reputation already does —
 * spamming low-effort answers earns little and costs match ratio.
 */

const BADGES_PREFIX = 'wbadges:';

export const XP_PER_ANSWER = 2;
export const XP_PER_MATCH = 10;
export const XP_PER_STREAK_DAY = 5;
const LEVEL_BASE_XP = 100;

/**
 * Badge catalog. `progress(ctx)` returns [current, target] so a client can
 * render a progress bar for badges not yet earned; a badge is earned once
 * current >= target.
 */
export const BADGES = Object.freeze([
  {
    id: 'first-answer',
    name: 'First Answer',
    description: 'Submit your first answer that reached settlement.',
    progress: (c) => [c.total, 1],
  },
  {
    id: 'ten-answers',
    name: 'Getting Started',
    description: 'Answer 10 questions.',
    progress: (c) => [c.total, 10],
  },
  {
    id: 'century',
    name: 'Century',
    description: 'Answer 100 questions.',
    progress: (c) => [c.total, 100],
  },
  {
    id: 'thousand',
    name: 'Veteran',
    description: 'Answer 1,000 questions.',
    progress: (c) => [c.total, 1000],
  },
  {
    id: 'established',
    name: 'Established',
    description: 'Answer enough questions to pass the reputation gate and appear on the leaderboard.',
    progress: (c) => [c.total, config.worker.minAnswersBeforeReputationGate],
  },
  {
    id: 'consensus-builder',
    name: 'Consensus Builder',
    description: 'Match consensus on 100 answers.',
    progress: (c) => [c.matched, 100],
  },
  {
    id: 'sharpshooter',
    name: 'Sharpshooter',
    description: 'Hold a match ratio of 90% or higher across at least 50 answers.',
    progress: (c) => [c.total >= 50 && c.matchRatio >= 0.9 ? 1 : 0, 1],
  },
  {
    id: 'perfect-day',
    name: 'Perfect Day',
    description: 'Answer at least 10 questions in one UTC day and match consensus on every one.',
    progress: (c) => [c.perfectDays, 1],
  },
  {
    id: 'streak-7',
    name: 'On a Roll',
    description: 'Answer at least once a day for 7 consecutive days.',
    progress: (c) => [c.longestStreak, 7],
  },
  {
    id: 'streak-30',
    name: 'Unstoppable',
    description: 'Answer at least once a day for 30 consecutive days.',
    progress: (c) => [c.longestStreak, 30],
  },
]);

/** Level n starts at LEVEL_BASE_XP * (n-1)^2 XP — quadratic, so early
 * levels come quickly and later ones need sustained, accurate work. */
export function levelForXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL_BASE_XP)) + 1;
}

export function xpForLevel(level) {
  return LEVEL_BASE_XP * (level - 1) ** 2;
}

export function computeXp({ total, matched, longestStreak }) {
  return total * XP_PER_ANSWER + matched * XP_PER_MATCH + longestStreak * XP_PER_STREAK_DAY;
}

function countPerfectDays(days) {
  return Object.values(days || {}).filter((b) => b.answered >= 10 && b.matched === b.answered).length;
}

/** Pure: everything badges and XP are computed from, in one place. */
export function buildContext(reputation, activity, now = Date.now()) {
  const streak = computeStreak(activity.days || {}, now);
  return {
    total: reputation.total,
    matched: reputation.matched,
    matchRatio: reputation.total > 0 ? reputation.matched / reputation.total : 0,
    currentStreak: streak.current,
    longestStreak: Math.max(streak.longest, activity.longestStreak || 0),
    perfectDays: countPerfectDays(activity.days),
  };
}

/** Pure: evaluates the catalog against a context and any previously stored
 * earnedAt timestamps. Returns badges plus the ids newly earned this call. */
export function evaluateBadges(ctx, earnedAt = {}, now = Date.now()) {
  const newlyEarned = [];
  const badges = BADGES.map((b) => {
    const [current, target] = b.progress(ctx);
    const earned = Boolean(earnedAt[b.id]) || current >= target;
    if (earned && !earnedAt[b.id]) newlyEarned.push(b.id);
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      earned,
      earnedAt: earnedAt[b.id] || (earned ? new Date(now).toISOString() : null),
      progress: { current: Math.min(current, target), target },
    };
  });
  return { badges, newlyEarned };
}

/** Pure: the full gamification profile from already-fetched data. */
export function buildProfile({ workerId, reputation, activity, earnedAt = {}, now = Date.now() }) {
  const ctx = buildContext(reputation, activity, now);
  const xp = computeXp(ctx);
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const { badges, newlyEarned } = evaluateBadges(ctx, earnedAt, now);
  return {
    workerId,
    xp,
    level,
    levelProgress: {
      xpIntoLevel: xp - floor,
      xpForNextLevel: ceiling - floor,
      nextLevelAt: ceiling,
      fraction: (xp - floor) / (ceiling - floor),
    },
    streak: { current: ctx.currentStreak, longest: ctx.longestStreak },
    badges,
    earnedCount: badges.filter((b) => b.earned).length,
    newlyEarned,
  };
}

async function getEarnedAt(workerId) {
  return (await store.get(BADGES_PREFIX + workerId)) || {};
}

/**
 * Called after each recorded outcome (see dispatch.js's recordOutcome):
 * persists the earnedAt of any badge crossed for the first time and returns
 * the new ids, so a caller could notify the worker. Badges once earned stay
 * earned — dropping below Sharpshooter's ratio later doesn't revoke it.
 */
export async function syncBadges(workerId, now = Date.now()) {
  const [reputation, activity, earnedAt] = await Promise.all([
    getReputation(workerId),
    getActivity(workerId),
    getEarnedAt(workerId),
  ]);
  const { badges, newlyEarned } = evaluateBadges(buildContext(reputation, activity, now), earnedAt, now);
  if (newlyEarned.length > 0) {
    const next = { ...earnedAt };
    for (const b of badges) if (newlyEarned.includes(b.id)) next[b.id] = b.earnedAt;
    await store.set(BADGES_PREFIX + workerId, next); // no TTL — durable
  }
  return newlyEarned;
}

export async function getGamificationProfile(workerId, now = Date.now()) {
  const [reputation, activity, earnedAt] = await Promise.all([
    getReputation(workerId),
    getActivity(workerId),
    getEarnedAt(workerId),
  ]);
  return buildProfile({ workerId, reputation, activity, earnedAt, now });
}

const ZERO_CONTEXT = Object.freeze({ total: 0, matched: 0, matchRatio: 0, currentStreak: 0, longestStreak: 0, perfectDays: 0 });

export function badgeCatalog() {
  return BADGES.map((b) => ({ id: b.id, name: b.name, description: b.description, target: b.progress(ZERO_CONTEXT)[1] }));
}

/** Pure: ranks profiles by XP, ties broken by badges earned. */
export function rankByXp(profiles, limit = 50) {
  return [...profiles]
    .sort((a, b) => b.xp - a.xp || b.earnedCount - a.earnedCount)
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      workerId: p.workerId,
      xp: p.xp,
      level: p.level,
      badges: p.earnedCount,
      currentStreak: p.streak.current,
    }));
}

/** XP leaderboard across every known worker. Unlike /leaderboard (accuracy,
 * established workers only), this includes newcomers — XP is dominated by
 * matched answers, so a fresh sybil identity can't outrank real history. */
export async function getXpLeaderboard(limit = 50, now = Date.now()) {
  const ids = await getKnownWorkerIds();
  const profiles = await Promise.all(ids.map((id) => getGamificationProfile(id, now)));
  return rankByXp(profiles, limit);
}

'use strict';

/**
 * Fraud-scoring analysis module (issue #96).
 *
 * Sits downstream of dispatch.js::recordOutcome(). Reads the per-worker
 * answer history (rep:{workerId}) and scores patterns that a simple
 * match-ratio threshold misses:
 *   - timing correlation with other workers (coordinated ring)
 *   - sudden late-history defection after a long honest streak
 *   - category clustering (ring answering the same narrow question set)
 *
 * Scoring is intentionally statistical (z-scores / ratios) rather than a
 * trained model: the fraud pattern adapts once workers know it exists, and
 * retraining/monitoring a model is operational burden we do not want yet.
 *
 * Default posture is flag-and-surface-to-admin only. Automatic exclusion
 * from dispatch eligibility requires an explicit config opt-in
 * (FRAUD_AUTO_EXCLUDE=true).
 */

const DEFAULT_CONFIG = {
  // Explicit opt-in for automatic dispatch exclusion. Default: flag only.
  autoExclude: false,
  // Minimum number of answers before a worker is scored at all.
  minAnswers: 8,
  // Score at/above which a worker is flagged for manual review.
  flagThreshold: 60,
  // Timing correlation window (ms) for two answers to be "co-answered".
  timingWindowMs: 1500,
  // Category concentration: fraction of answers in a single category.
  categoryConcentrationThreshold: 0.8,
};

function resolveConfig(overrides) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, overrides || {});
  if (overrides && overrides.autoExclude === undefined && process.env.FRAUD_AUTO_EXCLUDE) {
    cfg.autoExclude = String(process.env.FRAUD_AUTO_EXCLUDE).toLowerCase() === 'true';
  }
  return cfg;
}

/**
 * Normalize a stored history entry. Supports both the legacy aggregate
 * ({matched,total}) and the extended per-answer detail written by
 * recordOutcome().
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    workerId: entry.workerId,
    questionId: entry.questionId,
    category: entry.category || 'uncategorized',
    matched: entry.matched === true || entry.matched === 1,
    answeredAt: Number(entry.answeredAt) || 0,
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Timing correlation: fraction of this worker's answers that land within
 * timingWindowMs of another worker's answer on the same question. A ring
 * answering in lockstep scores high; independent workers score near zero.
 */
function timingCorrelationScore(history, peerHistories, cfg) {
  if (!history.length) return 0;
  const peerByQuestion = new Map();
  for (const peer of peerHistories) {
    for (const raw of peer) {
      const e = normalizeEntry(raw);
      if (!e || !e.questionId) continue;
      if (!peerByQuestion.has(e.questionId)) peerByQuestion.set(e.questionId, []);
      peerByQuestion.get(e.questionId).push(e.answeredAt);
    }
  }
  let correlated = 0;
  let considered = 0;
  for (const raw of history) {
    const e = normalizeEntry(raw);
    if (!e || !e.questionId || !e.answeredAt) continue;
    const peers = peerByQuestion.get(e.questionId);
    if (!peers || !peers.length) continue;
    considered += 1;
    const close = peers.some((t) => Math.abs(t - e.answeredAt) <= cfg.timingWindowMs);
    if (close) correlated += 1;
  }
  if (!considered) return 0;
  return correlated / considered;
}

/**
 * Late-history defection: a long honest streak followed by a sudden run of
 * misses. Returns 0..1 where 1 is a sharp, late defection.
 */
function lateDefectionScore(history) {
  const entries = history.map(normalizeEntry).filter(Boolean);
  if (entries.length < 4) return 0;
  const outcomes = entries.map((e) => (e.matched ? 1 : 0));
  const split = Math.floor(outcomes.length * 0.7);
  const early = outcomes.slice(0, split);
  const late = outcomes.slice(split);
  if (!early.length || !late.length) return 0;
  const earlyRate = mean(early);
  const lateRate = mean(late);
  // Only a drop from a strong honest streak counts as defection.
  if (earlyRate < 0.8) return 0;
  const drop = earlyRate - lateRate;
  return Math.max(0, Math.min(1, drop));
}

/**
 * Category clustering: concentration of answers in a single category,
 * weighted by how narrow the set of distinct questions is.
 */
function categoryClusteringScore(history, cfg) {
  const entries = history.map(normalizeEntry).filter(Boolean);
  if (entries.length < 3) return 0;
  const counts = new Map();
  for (const e of entries) {
    counts.set(e.category, (counts.get(e.category) || 0) + 1);
  }
  let maxCount = 0;
  for (const c of counts.values()) maxCount = Math.max(maxCount, c);
  const concentration = maxCount / entries.length;
  if (concentration < cfg.categoryConcentrationThreshold) return 0;
  return Math.min(1, (concentration - cfg.categoryConcentrationThreshold) /
    (1 - cfg.categoryConcentrationThreshold) * 0.5 + 0.5);
}

/**
 * Score a single worker's history against peer histories.
 * Returns { workerId, score, flagged, signals }.
 */
function scoreWorker(workerId, history, peerHistories, overrides) {
  const cfg = resolveConfig(overrides);
  const entries = (history || []).map(normalizeEntry).filter(Boolean);
  if (entries.length < cfg.minAnswers) {
    return { workerId, score: 0, flagged: false, signals: {}, insufficientData: true };
  }

  const timing = timingCorrelationScore(entries, peerHistories || [], cfg);
  const defection = lateDefectionScore(entries);
  const clustering = categoryClusteringScore(entries, cfg);

  // Weighted blend, scaled to 0..100.
  const raw = timing * 0.45 + defection * 0.35 + clustering * 0.20;
  const score = Math.round(raw * 100);
  const flagged = score >= cfg.flagThreshold;

  return {
    workerId,
    score,
    flagged,
    signals: {
      timingCorrelation: Number(timing.toFixed(3)),
      lateDefection: Number(defection.toFixed(3)),
      categoryClustering: Number(clustering.toFixed(3)),
    },
  };
}

/**
 * Score a batch of workers. `histories` is a map of workerId -> history.
 */
function scoreAll(histories, overrides) {
  const ids = Object.keys(histories || {});
  const results = [];
  for (const id of ids) {
    const peers = ids.filter((other) => other !== id).map((other) => histories[other]);
    results.push(scoreWorker(id, histories[id], peers, overrides));
  }
  return results;
}

/**
 * Asynchronous scoring entry point. Runs off the settlement critical path:
 * callers fire-and-forget and never await this inside settleResolved() /
 * settleRefunded(). Returns a promise resolving to the scored results.
 */
function scoreAsync(histories, overrides) {
  return new Promise((resolve) => {
    // Defer to the next tick so settlement callers are never blocked.
    setImmediate(() => {
      try {
        resolve(scoreAll(histories, overrides));
      } catch (err) {
        resolve([]);
      }
    });
  });
}

/**
 * Whether a flagged worker should be excluded from dispatch eligibility.
 * Only true when the explicit autoExclude config flag is set.
 */
function shouldAutoExclude(result, overrides) {
  const cfg = resolveConfig(overrides);
  return Boolean(cfg.autoExclude && result && result.flagged);
}

module.exports = {
  DEFAULT_CONFIG,
  resolveConfig,
  scoreWorker,
  scoreAll,
  scoreAsync,
  shouldAutoExclude,
  timingCorrelationScore,
  lateDefectionScore,
  categoryClusteringScore,
};

/**
 * Aggregate counters for the public /stats surface. Kept as a tiny pure
 * module so the counters are trivially testable and have no hidden state of
 * their own — callers own persistence.
 *
 * Issue #13 adds shadow-mode AI baseline counters alongside the existing
 * resolved/refunded tallies: for questions dispatched on a real quorum tier
 * we also generate the instant-tier LLM draft in shadow and record whether it
 * matched the human-reconciled consensus. These counters are keyed the same
 * way as resolved/refunded so they aggregate with the same machinery, and are
 * purely observability — they never touch settlement, timing, or cost.
 *
 * Issue #152 adds per-customer usage counters keyed by
 * `usage:{accountId}:{endpoint}:{tier}:{day}` so API customers can see their
 * own per-endpoint/per-tier call patterns via GET /billing/usage. These are
 * written from the same resolveApiKey()-gated request flow as the platform
 * counters and, like the platform counters, exclude sandbox traffic.
 *
 * Issue #93 adds a short-TTL cache in front of getStats()'s two-counter read
 * so request-volume spikes on the public, unauthenticated /stats endpoint
 * don't hammer the Redis connection. The cache lives in store.js (shared
 * across instances, same shape as anchorClient.js's stellar.toml cache) and
 * degrades to the uncached read if the cache backend is briefly unreachable.
 *
 * Issue #87 adds experiment-scoped outcome counters keyed by
 * `experiment:{experimentId}:{variant}:{outcome}` so A/B pricing variants can
 * be compared (resolved vs. refunded, settlement price, time-to-reconcile)
 * without re-deriving them from raw job records. These are only written when
 * an experiment is active; with the experiment disabled no variant tagging
 * happens at all.
 */
import { store } from './store.js';

/**
 * Durable, platform-wide counters — real settlement outcomes only.
 * Sandbox settlements deliberately never call this: mixing simulated
 * traffic into a "questions resolved" stat used for trust-building would
 * make the number meaningless the moment sandbox usage outpaces real usage.
 */
const PREFIX = 'stats:';

/**
 * Short TTL for the cached /stats read. Seconds, not minutes: the counters
 * are cheap to recompute, so the cache only needs to absorb request-volume
 * spikes. Staleness is bounded by this window.
 */
export const STATS_CACHE_TTL_MS = 5 * 1000;
const STATS_CACHE_KEY = PREFIX + 'cache:summary';

export async function incrementStat(name) {
  await store.incr(PREFIX + name);
}

export async function getStats() {
  // Serve from the shared cache when available. Any cache-backend failure
  // (e.g. Redis briefly unreachable) falls through to the uncached read so
  // /stats degrades to current behavior rather than a 500.
  try {
    const cached = await store.get(STATS_CACHE_KEY);
    if (cached) return cached;
  } catch {
    // Ignore cache read failures and recompute below.
  }

  const [totalResolved, totalRefunded] = await Promise.all([
    store.get(PREFIX + 'resolved'),
    store.get(PREFIX + 'refunded'),
  ]);
  const resolved = totalResolved || 0;
  const refunded = totalRefunded || 0;
  const result = {
    totalResolved: resolved,
    totalRefunded: refunded,
    totalSettled: resolved + refunded,
  };

  try {
    await store.set(STATS_CACHE_KEY, result, STATS_CACHE_TTL_MS);
  } catch {
    // Cache write failures are non-fatal; the uncached result is still valid.
  }

  return result;
}

export function emptyStats() {
  return {
    resolved: 0,
    refunded: 0,
    // Shadow-mode AI baseline (issue #13).
    shadowMatched: 0,
    shadowMismatched: 0,
    shadowRefunded: 0,
  };
}

/**
 * Folds a single shadow-agreement record (see pricing.js's
 * recordShadowAgreement) into the running counters. A record that wasn't
 * counted (refunded / no consensus) only bumps shadowRefunded, so the
 * agreement rate stays a clean matched/(matched+mismatched) ratio.
 */
export function applyShadowAgreement(stats, record) {
  if (!record || !record.counted) {
    return { ...stats, shadowRefunded: stats.shadowRefunded + 1 };
  }
  return record.matched
    ? { ...stats, shadowMatched: stats.shadowMatched + 1 }
    : { ...stats, shadowMismatched: stats.shadowMismatched + 1 };
}

/**
 * Public view of the counters, including the aggregate shadow agreement rate.
 * `shadowAgreementRate` is null until at least one comparison has been
 * counted, so we never publish a misleading 0% before any data exists.
 */
export function publicStats(stats) {
  const counted = stats.shadowMatched + stats.shadowMismatched;
  return {
    resolved: stats.resolved,
    refunded: stats.refunded,
    shadow: {
      matched: stats.shadowMatched,
      mismatched: stats.shadowMismatched,
      refunded: stats.shadowRefunded,
      counted,
      agreementRate: counted > 0 ? stats.shadowMatched / counted : null,
    },
  };
}

/**
 * Builds the per-customer usage counter key. Mirrors the shape used by the
 * platform counters: one key per (account, endpoint, tier, day) so a rolling
 * window can be read back without scanning unrelated keys.
 */
export function usageKey(accountId, endpoint, tier, day) {
  return `usage:${accountId}:${endpoint}:${tier}:${day}`;
}

/**
 * Records a single API call against the per-customer usage counters. Sandbox
 * traffic is excluded here for the same reason stats.js excludes it from the
 * platform-wide numbers: it isn't real customer usage. Returns the key that
 * was incremented (or null when the call was skipped) so callers can log or
 * test the write without re-deriving the key.
 */
export async function recordUsage(store, { accountId, endpoint, tier, sandbox, day } = {}) {
  if (sandbox) return null;
  if (!accountId || !endpoint || !tier) return null;
  const key = usageKey(accountId, endpoint, tier, day || new Date().toISOString().slice(0, 10));
  await store.incrBy(key, 1);
  return key;
}

/**
 * Reads back a per-endpoint/per-tier breakdown for one account over a recent
 * window of days. `days` is the rolling window (default 30) and `now` is
 * injectable so tests don't depend on the wall clock. Returns
 * `{ accountId, days, total, endpoints: { [endpoint]: { total, tiers: {...} } } }`.
 *
 * Issue #332: the original implementation issued one `listKeys()` call per
 * day in the window (30+ round-trips for the default window, more for larger
 * caller-supplied `days`). Since every usage key for an account shares the
 * `usage:{accountId}:` prefix, a single prefix scan covers the whole window;
 * we then filter to the requested days in memory. This keeps the read cost
 * flat in the window size instead of linear in it.
 */
export async function getUsage(store, accountId, { days = 30, now = new Date() } = {}) {
  const endpoints = {};
  let total = 0;
  const prefix = `usage:${accountId}:`;
  const wantedDays = new Set();
  for (let i = 0; i < days; i += 1) {
    wantedDays.add(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  const keys = await store.listKeys(`${prefix}*`);
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const sep = rest.lastIndexOf(':');
    if (sep < 0) continue;
    const day = rest.slice(sep + 1);
    if (!wantedDays.has(day)) continue;
    const endpointTier = rest.slice(0, sep);
    const tierSep = endpointTier.lastIndexOf(':');
    if (tierSep < 0) continue;
    const endpoint = endpointTier.slice(0, tierSep);
    const tier = endpointTier.slice(tierSep + 1);
    const count = Number(await store.get(key)) || 0;
    if (!count) continue;
    if (!endpoints[endpoint]) endpoints[endpoint] = { total: 0, tiers: {} };
    endpoints[endpoint].tiers[tier] = (endpoints[endpoint].tiers[tier] || 0) + count;
    endpoints[endpoint].total += count;
    total += count;
  }
  return { accountId, days, total, endpoints };
}

/**
 * Experiment-scoped outcome counters (issue #87). Keyed by
 * `experiment:{experimentId}:{variant}:{outcome}` so a per-variant breakdown
 * can be read back with a single prefix scan. Outcomes are the settlement
 * result (`resolved` / `refunded`) plus the aggregate settlement price and
 * time-to-reconcile, which are summed so callers can derive averages.
 */
export function experimentKey(experimentId, variant, outcome) {
  return `experiment:${experimentId}:${variant}:${outcome}`;
}

/**
 * Records one settlement outcome against the variant that produced it. Only
 * called when an experiment is active, so a disabled experiment adds no
 * variant-tagging overhead. `settlementPrice` and `timeToReconcileMs` are
 * summed under dedicated keys so the admin endpoint can report averages
 * without re-deriving them from raw job records.
 */
export async function recordExperimentOutcome(
  experimentId,
  variant,
  { outcome, settlementPrice, timeToReconcileMs } = {},
) {
  if (!experimentId || !variant || !outcome) return null;
  await store.incr(experimentKey(experimentId, variant, outcome));
  if (Number.isFinite(settlementPrice)) {
    await store.incrBy(experimentKey(experimentId, variant, 'settlementPrice'), settlementPrice);
  }
  if (Number.isFinite(timeToReconcileMs)) {
    await store.incrBy(experimentKey(experimentId, variant, 'timeToReconcileMs'), timeToReconcileMs);
  }
  return experimentKey(experimentId, variant, outcome);
}

/**
 * Reads back the per-variant breakdown for one experiment. Returns
 * `{ experimentId, variants: { [variant]: { resolved, refunded, settled,
 * settlementPrice, avgSettlementPrice, timeToReconcileMs,
 * avgTimeToReconcileMs } } }`. Averages are null until at least one outcome
 * has been recorded, so we never publish a misleading 0 before any data
 * exists.
 */
export async function getExperimentResults(experimentId) {
  const variants = {};
  if (!experimentId) return { experimentId, variants };
  const prefix = `experiment:${experimentId}:`;
  const keys = await store.listKeys(`${prefix}*`);
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const sep = rest.lastIndexOf(':');
    if (sep < 0) continue;
    const variant = rest.slice(0, sep);
    const outcome = rest.slice(sep + 1);
    const value = Number(await store.get(key)) || 0;
    if (!variants[variant]) {
      variants[variant] = {
        resolved: 0,
        refunded: 0,
        settled: 0,
        settlementPrice: 0,
        avgSettlementPrice: null,
        timeToReconcileMs: 0,
        avgTimeToReconcileMs: null,
      };
    }
    const v = variants[variant];
    if (outcome === 'resolved' || outcome === 'refunded') {
      v[outcome] += value;
      v.settled += value;
    } else if (outcome === 'settlementPrice') {
      v.settlementPrice += value;
    } else if (outcome === 'timeToReconcileMs') {
      v.timeToReconcileMs += value;
    }
  }
  for (const v of Object.values(variants)) {
    if (v.settled > 0) {
      v.avgSettlementPrice = v.settlementPrice / v.settled;
      v.avgTimeToReconcileMs = v.timeToReconcileMs / v.settled;
    }
  }
  return { experimentId, variants };
}

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
 */

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
 */
export async function getUsage(store, accountId, { days = 30, now = new Date() } = {}) {
  const endpoints = {};
  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const day = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    const prefix = `usage:${accountId}:`;
    const keys = await store.listKeys(`${prefix}*:${day}`);
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const sep = rest.lastIndexOf(':');
      if (sep < 0) continue;
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
  }
  return { accountId, days, total, endpoints };
}

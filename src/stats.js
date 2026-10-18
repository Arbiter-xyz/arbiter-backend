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


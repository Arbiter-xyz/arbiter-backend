import { store } from './store.js';

/**
 * Generic fixed-window rate limiter backed by the shared store — atomic and
 * globally-shared when Redis is configured, per-process-only when it isn't
 * (same tradeoff as everything else routed through store.js).
 *
 * Applied to every endpoint that either costs the platform money to serve
 * (the /sponsor/* fee-bump relays each spend a real network fee) or writes
 * unbounded state (POST /oracle stashes a new pending question per call).
 */
export async function checkRateLimit(key, max, windowMs) {
  const count = await store.incr(`ratelimit:${key}`, windowMs);
  return count <= max;
}

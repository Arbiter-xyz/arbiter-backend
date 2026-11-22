import { createHash } from 'node:crypto';
import { store } from './store.js';

/**
 * API-key auth for the fiat/pooled-custody onramp (see billing.js) — the
 * multi-tenant counterpart to adminAuth.js's single shared token. Customer
 * keys are hashed at rest (adminAuth's one operator-controlled secret in an
 * env var doesn't need this; a table of many customer-controlled secrets
 * does), and lookup never throws — callers decide how to respond to a
 * missing/invalid key, same as this codebase's existing pattern of keeping
 * eligibility/auth checks side-effect-free and let the route handler own
 * the HTTP status.
 */

const KEY_PREFIX = 'ak_live_';

/** Trust tiers, lowest to highest. `base` is equivalent to today's fixed
 * config.rateLimits[bucket].max; higher tiers get a larger ceiling. */
export const TRUST_TIERS = ['base', 'trusted', 'premium'];

/** Multiplier applied to a bucket's base `max` for each elevated tier. */
const TIER_MULTIPLIERS = { base: 1, trusted: 5, premium: 20 };

export function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Returns the raw `ak_live_...` key from the Authorization header, or
 * null if missing/malformed. Does not check the key exists. */
export function extractApiKey(req) {
  const header = req.get('authorization') || '';
  const [scheme, rawKey] = header.split(' ');
  if (scheme !== 'Bearer' || !rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  return rawKey;
}

/** Returns the accountId a raw key resolves to, or null if the header is
 * missing, malformed, or the key doesn't exist. Never throws. */
export async function resolveApiKey(req) {
  const rawKey = extractApiKey(req);
  if (!rawKey) return null;

  const record = await store.get(`apikey:${hashApiKey(rawKey)}`);
  if (!record) return null;

  const account = await store.get(`account:${record.accountId}`);
  if (account && account.suspended) return null;

  return record.accountId;
}

/** Returns the trust tier for an accountId, defaulting to `base`. Fails
 * closed to `base` on any lookup error or unknown tier — never returns an
 * elevated tier unless the store explicitly says so. */
export async function resolveTrustTier(accountId) {
  if (!accountId) return 'base';
  try {
    const account = await store.get(`account:${accountId}`);
    const tier = account && account.tier;
    return TRUST_TIERS.includes(tier) ? tier : 'base';
  } catch {
    return 'base';
  }
}

/** Scales a bucket's base `max` by the multiplier for `tier`. Unknown tiers
 * fall back to the base multiplier (fail closed). */
export function tieredMax(baseMax, tier) {
  const multiplier = TIER_MULTIPLIERS[tier] || TIER_MULTIPLIERS.base;
  return Math.floor(baseMax * multiplier);
}

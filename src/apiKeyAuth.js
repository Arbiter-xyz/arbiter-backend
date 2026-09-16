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

export function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Returns the accountId a raw key resolves to, or null if the header is
 * missing, malformed, or the key doesn't exist. Never throws. */
export async function resolveApiKey(req) {
  const header = req.get('authorization') || '';
  const [scheme, rawKey] = header.split(' ');
  if (scheme !== 'Bearer' || !rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const record = await store.get(`apikey:${hashApiKey(rawKey)}`);
  return record ? record.accountId : null;
}

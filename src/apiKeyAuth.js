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
 * missing, malformed, the key doesn't exist, or the account is suspended.
 * Never throws. Fails closed on suspension the same way requireAdmin /
 * isBillingConfigured do elsewhere in this codebase — a suspended key is
 * rejected here, before the request ever reaches reserveCredit(). */
export async function resolveApiKey(req) {
  const header = req.get('authorization') || '';
  const [scheme, rawKey] = header.split(' ');
  if (scheme !== 'Bearer' || !rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const record = await store.get(`apikey:${hashApiKey(rawKey)}`);
  if (!record) return null;

  const account = await store.get(`account:${record.accountId}`);
  if (account && account.suspended) return null;

  return record.accountId;
}

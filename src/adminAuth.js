import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { hashApiKey } from './apiKeyAuth.js';

/**
 * Constant-time string comparison so a wrong admin token can't leak
 * timing information about the secret. Mirrors the discipline in
 * workerAuth.js::verifySessionToken(). timingSafeEqual throws on
 * mismatched-length buffers, so the length is checked first.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Gate for every /admin/* route. Deliberately a single shared bearer
 * token, not a session/account system — see config.js's `admin` block for
 * why. Refuses every request (rather than failing open) when ADMIN_TOKEN
 * is unset, so an operator can't accidentally ship this surface wide open
 * by forgetting to configure it.
 *
 * Role-based admin permissions (#131) layer on top of this shared token:
 * a request may additionally present an `x-admin-role` header naming the
 * role it is acting as. `requireAdmin` still authenticates the shared
 * token; `requireRole` then enforces that the authenticated caller holds
 * the role a route needs. This is what lets escalation (#125) route
 * unresolved items to a designated senior reviewer instead of any admin
 * token holder.
 */

const ROLE_READONLY = 'readonly';
const ROLE_FULL = 'full';

/** Constant-time string comparison that tolerates differing lengths. */
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do a comparison so the failure path isn't obviously faster.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Derive a stable, non-reversible session id from a credential hash. */
function sessionIdForHash(hash) {
  return crypto.createHash('sha256').update(`admin-session:${hash}`).digest('hex').slice(0, 32);
}

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !safeEqual(token, config.admin.token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  return null;
}

/** Resolve the role granted by a presented token, or null if it matches no
 * configured credential. */
export function resolveAdminRole(token) {
  const cred = resolveAdminCredential(token);
  return cred ? cred.role : null;
}

/** True when `role` is allowed to satisfy a route requiring `required`. */
function roleSatisfies(role, required) {
  if (role === ROLE_FULL) return true;
  if (required === ROLE_READONLY) return role === ROLE_READONLY;
  return false;
}

/**
 * Express middleware factory. `requireAdmin()` (or `requireAdmin('full')`)
 * requires a full-admin credential; `requireAdmin('readonly')` accepts either
 * a read-only or a full credential. Rejects with 401 when no credential is
 * presented/matched, and 403 when a valid credential lacks the required role.
 *
 * On success the resolved role and session id are attached to the request so
 * downstream audit/recording middleware can attribute the call to a caller
 * session (#132).
 */
export function requireAdmin(required = ROLE_FULL) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const cred = resolveAdminCredential(token);

    if (!cred) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!roleSatisfies(cred.role, required)) {
      return res.status(403).json({ error: 'forbidden', requiredRole: required });
    }

    req.adminRole = cred.role;
    req.adminSessionId = cred.sessionId;
    return next();
  };
}

/**
 * Roles an authenticated admin may act as. `reviewer` handles the manual
 * review queue (#123) and disputes (#124); `senior_reviewer` is the
 * designated escalation target (#125). Kept as a plain list so the set of
 * roles is one obvious place to extend.
 */
export const ADMIN_ROLES = ['reviewer', 'senior_reviewer'];

/**
 * Resolve the role an authenticated admin request is acting as. Defaults
 * to `reviewer` so existing callers that only send the shared token keep
 * working unchanged; an explicit `x-admin-role` header opts into a
 * different role. Unknown roles resolve to null so `requireRole` can
 * reject them rather than silently downgrading.
 */
export function adminRole(req) {
  const role = req.get('x-admin-role');
  if (!role) return 'reviewer';
  return ADMIN_ROLES.includes(role) ? role : null;
}

/**
 * Route guard for role-restricted admin surfaces. Must run after
 * `requireAdmin` so the shared token has already been verified. Rejects
 * requests whose resolved role isn't in `roles`, which is how escalation
 * (#125) keeps senior-reviewer-only actions off the plain reviewer role.
 */
export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    const role = adminRole(req);
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'forbidden: insufficient admin role' });
    }
    req.adminRole = role;
    next();
  };
}

/**
 * Admin-only provisioning of an invoice/PO-billed account (#106).
 *
 * Enterprise customers paying by purchase order or wire transfer have no
 * card, so the self-serve `createCheckoutSession()` flow (and its Stripe
 * `isBillingConfigured()` gate) doesn't apply to them. This handler lets an
 * operator confirm an out-of-band payment and provision credit directly:
 *
 *   1. `createAccount()` mints the account + API key, skipping Stripe.
 *   2. `store.incrBy()` credits `credit:{accountId}` — the same primitive
 *      `handleStripeWebhook()` uses, just triggered by an operator instead
 *      of a webhook.
 *
 * The raw API key is returned exactly once in this response (there is no
 * checkout redirect to embed it in). It is never persisted or logged in
 * plaintext — key recovery remains a deliberate v1 gap, mirroring
 * `createCheckoutSession()`'s existing one-time-reveal comment.
 *
 * Downstream, a manually-provisioned account is indistinguishable from a
 * Stripe-funded one: POST /oracle still goes through the same
 * reserveCredit()/settleReservation() path with no special-casing.
 *
 * Structured accounts-receivable tracking (invoice number, due date,
 * payment status) is explicitly out of scope for this primitive.
 */
export function createInvoiceBilledAccount({ createAccount, store }) {
  return async function provisionInvoiceBilledAccount(req, res) {
    const { amount } = req.body || {};
    const credit = Number(amount);
    if (!Number.isFinite(credit) || credit <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number of credits' });
    }

    const account = await createAccount();
    await store.incrBy(`credit:${account.accountId}`, credit);

    // One-time reveal: the raw key is returned here and nowhere else.
    return res.status(201).json({
      accountId: account.accountId,
      apiKey: account.apiKey,
      credited: credit,
      billing: 'invoice',
    });
  };
}

/**
 * Gate for GET /metrics. Reuses the exact same bearer-token check as
 * /admin/* (requireAdmin) so the Prometheus scrape endpoint is protected
 * by the same ADMIN_TOKEN and the same fail-closed behavior when it is
 * unset. Kept as a named alias rather than a second implementation so the
 * two surfaces can never drift apart.
 */
export const requireMetricsAuth = requireAdmin;

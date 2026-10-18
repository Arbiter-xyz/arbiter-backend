import { timingSafeEqual, createHash } from 'node:crypto';
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

/** Derive a stable, non-reversible session id from a credential hash. */
function sessionIdForHash(hash) {
  return createHash('sha256').update(`admin-session:${hash}`).digest('hex').slice(0, 32);
}

/**
 * Resolve a presented bearer token against the one configured admin
 * secret. There's only one shared token (see the module doc comment above
 * for why), so any match grants ROLE_FULL — the reviewer/senior_reviewer
 * split below is a separate, additive layer on top of this, not a second
 * tier of secrets.
 */
function resolveAdminCredential(token) {
  if (!token || !safeEqual(token, config.admin.token)) return null;
  return { role: ROLE_FULL, sessionId: sessionIdForHash(token) };
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
 * Resolver-level admin guard for GraphQL (#74). GraphQL doesn't route
 * through Express middleware per-field the way REST routes do, so admin
 * fields call this directly from their resolvers. It reuses the exact same
 * credential check as `requireAdmin` (via `resolveAdminCredential`) so the
 * two surfaces can never drift apart, and throws a GraphQLError carrying
 * the same 401/403 status the REST middleware would return — an
 * unauthenticated admin query is rejected, never silently resolved to null.
 *
 * `context` is the per-request GraphQL context; the bearer token is read
 * from `context.req.headers.authorization`, mirroring the REST middleware.
 */
export function requireAdminResolver(context, required = ROLE_FULL) {
  const header = (context && context.req && context.req.headers.authorization) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cred = resolveAdminCredential(token);

  if (!cred) {
    const err = new Error('unauthorized');
    err.extensions = { code: 'UNAUTHENTICATED', http: { status: 401 } };
    throw err;
  }
  if (!roleSatisfies(cred.role, required)) {
    const err = new Error('forbidden');
    err.extensions = { code: 'FORBIDDEN', http: { status: 403 }, requiredRole: required };
    throw err;
  }

  return cred;
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


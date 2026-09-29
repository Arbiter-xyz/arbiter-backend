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

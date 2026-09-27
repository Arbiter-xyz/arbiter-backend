import crypto from 'node:crypto';
import { config } from './config.js';
import { hashApiKey } from './apiKeyAuth.js';

/**
 * Admin authentication.
 *
 * Historically this was a single shared operator secret (`config.admin.token`)
 * compared in constant time. A single operator secret didn't need hashing at
 * rest — it lives in the deployment's env, not in a datastore this backend
 * controls. Once there is more than one admin credential, though, the same
 * reasoning billing.js's API keys rely on applies: a table of many
 * customer-controlled secrets should be stored hashed, so a leaked datastore
 * snapshot doesn't hand out live credentials.
 *
 * Credentials are therefore a small, fixed table of `{ hash, role }` entries
 * (see config.js's admin.credentials). Roles are intentionally coarse —
 * `readonly` may only call read-only /admin/* routes, `full` may call
 * everything — consistent with this codebase's "no user-account system"
 * design principle: a fixed set of operator roles, not a general RBAC system.
 *
 * Backwards compatibility: the legacy single `ADMIN_TOKEN` env var keeps
 * working as an implicit `full` credential, so existing deployments (including
 * the live Railway one) are not silently locked out. It is checked after the
 * credential table, so a deployment that has migrated to hashed credentials
 * can drop ADMIN_TOKEN without any code change.
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

/** Resolve the role granted by a presented token, or null if it matches no
 * configured credential. Checks the hashed credential table first, then the
 * legacy ADMIN_TOKEN compat path. */
export function resolveAdminRole(token) {
  if (!token) return null;

  const presentedHash = hashApiKey(token);
  for (const cred of config.admin.credentials) {
    if (timingSafeEqual(presentedHash, cred.hash)) return cred.role;
  }

  // Legacy compat: the single ADMIN_TOKEN is an implicit full-admin credential.
  if (config.admin.token && timingSafeEqual(token, config.admin.token)) {
    return ROLE_FULL;
  }

  return null;
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
 */
export function requireAdmin(required = ROLE_FULL) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const role = resolveAdminRole(token);

    if (!role) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!roleSatisfies(role, required)) {
      return res.status(403).json({ error: 'forbidden', requiredRole: required });
    }

    req.adminRole = role;
    return next();
  };
}

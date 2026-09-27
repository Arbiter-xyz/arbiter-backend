import { config } from './config.js';

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
export function requireAdmin(req, res, next) {
  if (!config.admin.token) {
    return res.status(503).json({ error: 'admin console not configured (ADMIN_TOKEN unset)' });
  }

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== config.admin.token) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
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

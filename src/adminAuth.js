import { config } from './config.js';

/**
 * Gate for every /admin/* route. Deliberately a single shared bearer
 * token, not a session/account system — see config.js's `admin` block for
 * why. Refuses every request (rather than failing open) when ADMIN_TOKEN
 * is unset, so an operator can't accidentally ship this surface wide open
 * by forgetting to configure it.
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
 * Gate for GET /metrics. Reuses the exact same bearer-token check as
 * /admin/* (requireAdmin) so the Prometheus scrape endpoint is protected
 * by the same ADMIN_TOKEN and the same fail-closed behavior when it is
 * unset. Kept as a named alias rather than a second implementation so the
 * two surfaces can never drift apart.
 */
export const requireMetricsAuth = requireAdmin;

import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

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
export function requireAdmin(req, res, next) {
  if (!config.admin.token) {
    return res.status(503).json({ error: 'admin console not configured (ADMIN_TOKEN unset)' });
  }

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !safeEqual(token, config.admin.token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

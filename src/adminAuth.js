import { config } from './config.js';
import { recordAuditEntry } from './auditLog.js';
import { verifyTotp } from './totp.js';

/**
 * Single shared bearer-token gate for every /admin/* route. There is no
 * per-caller identity today (that's #131's job), so the audit log records
 * only that an action occurred and which route/status it produced.
 *
 * When `config.adminTotpSecret` is configured, a valid bearer token alone is
 * no longer sufficient: the caller must also present a valid time-based
 * second-factor code. This follows the same fail-closed-if-configured,
 * unchanged-if-not pattern as `config.billing`/`config.anchor`.
 */
export function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!config.adminToken) {
    // Fail closed: no configured token means admin is unavailable, not open.
    recordAuditEntry({
      route: req.path,
      method: req.method,
      status: 503,
      requestId: req.id,
    }).catch(() => {});
    return res.status(503).json({ error: 'admin_unavailable' });
  }

  if (!token || token !== config.adminToken) {
    recordAuditEntry({
      route: req.path,
      method: req.method,
      status: 401,
      requestId: req.id,
    }).catch(() => {});
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Second factor: only enforced when a TOTP secret is configured. When it is
  // absent, behavior is unchanged from the single-token model.
  if (config.adminTotpSecret) {
    const code = req.headers['x-admin-totp'] || req.query.totp;
    if (!verifyTotp(config.adminTotpSecret, code)) {
      recordAuditEntry({
        route: req.path,
        method: req.method,
        status: 401,
        requestId: req.id,
      }).catch(() => {});
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Record the successful admin call. The handler's own status isn't known
  // yet, so the gate records the authorization outcome (200) — the durable
  // record proves the call was made and authorized.
  recordAuditEntry({
    route: req.path,
    method: req.method,
    status: 200,
    requestId: req.id,
  }).catch(() => {});

  return next();
}

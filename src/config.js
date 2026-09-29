import 'dotenv/config';

/**
 * Central runtime configuration.
 *
 * Design principle: this backend has no user-account system anywhere. Every
 * credential is either a per-customer API key (billing.js) or a small, fixed
 * set of operator credentials (admin) — never a general user/org model.
 */

function parseAdminCredentials(raw) {
  // ADMIN_CREDENTIALS is a comma-separated list of `role:hash` pairs, where
  // `hash` is apiKeyAuth.js's hashApiKey() output for the operator's secret.
  // Example: ADMIN_CREDENTIALS="readonly:<sha256hex>,full:<sha256hex>"
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return null;
      const role = entry.slice(0, idx).trim();
      const hash = entry.slice(idx + 1).trim();
      if (role !== 'readonly' && role !== 'full') return null;
      if (!hash) return null;
      return { role, hash };
    })
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  platformAddress: process.env.PLATFORM_ADDRESS || '',
  usdc: {
    code: process.env.USDC_CODE || 'USDC',
    issuer: process.env.USDC_ISSUER || '',
  },
  worker: {
    minAnswersBeforeReputationGate: Number(process.env.MIN_ANSWERS_BEFORE_REPUTATION_GATE || 5),
  },
  admin: {
    // Legacy single operator secret. Kept as an implicit full-admin credential
    // for backwards compatibility with existing deployments (incl. Railway).
    token: process.env.ADMIN_TOKEN || '',
    // Hashed, role-carrying operator credentials. Takes precedence over the
    // legacy token when present; a deployment can migrate by setting this and
    // then dropping ADMIN_TOKEN.
    credentials: parseAdminCredentials(process.env.ADMIN_CREDENTIALS),
  },
  billing: {
    fiatPoolAddress: process.env.FIAT_POOL_ADDRESS || '',
  },
  rateLimits: {
    // Free, unauthenticated, LLM-cost-bearing endpoints each get their own
    // bucket so a burst on one cannot starve the others.
    sandbox: {
      windowMs: Number(process.env.RATE_LIMIT_SANDBOX_WINDOW_MS || 60_000),
      max: Number(process.env.RATE_LIMIT_SANDBOX_MAX || 30),
    },
    oracle: {
      windowMs: Number(process.env.RATE_LIMIT_ORACLE_WINDOW_MS || 60_000),
      max: Number(process.env.RATE_LIMIT_ORACLE_MAX || 60),
    },
    sponsor: {
      windowMs: Number(process.env.RATE_LIMIT_SPONSOR_WINDOW_MS || 60_000),
      max: Number(process.env.RATE_LIMIT_SPONSOR_MAX || 20),
    },
    // FAQ search is a similarly free, unauthenticated, LLM-cost-bearing
    // endpoint, so it follows the same bucket pattern as sandbox/oracle/sponsor.
    faq: {
      windowMs: Number(process.env.RATE_LIMIT_FAQ_WINDOW_MS || 60_000),
      max: Number(process.env.RATE_LIMIT_FAQ_MAX || 30),
    },
  },
};

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

// Falls back to a random per-process secret if unset — sessions won't
// survive a restart in that mode (consistent with every other piece of
// default in-memory state in this system), but it's still real HMAC
// protection, not a hardcoded/guessable value. Set SESSION_SECRET
// explicitly for anything beyond local dev.
let sessionSecretFallbackWarned = false;
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!sessionSecretFallbackWarned) {
    console.warn('[config] SESSION_SECRET not set — generating a random per-process secret (worker sessions will not survive a restart)');
    sessionSecretFallbackWarned = true;
  }
  return randomBytes(32).toString('hex');
}
const SESSION_SECRET = sessionSecret();

// Per-customer outbound webhook retry policy (#154). Shaped like retry.js's
// withRetry(fn, { attempts, baseDelayMs, ... }) options so the delivery
// worker from #56 reuses that exponential-backoff algorithm rather than a
// second one. These are the bounds a customer's policy is validated against
// at configuration time — out-of-range values are rejected, never silently
// clamped at delivery time.
export const WEBHOOK_RETRY_POLICY_BOUNDS = Object.freeze({
  minAttempts: 1,
  maxAttempts: 10,
  minBaseDelayMs: 100,
  // Caps the retry window so a customer can't configure an effectively
  // infinite loop that pins delivery-worker resources indefinitely.
  maxBaseDelayMs: 60_000,
});

// Baseline policy #56 ships with when a customer has no policy configured.
// Matches the existing bounded-retry posture in retry.js.
export const DEFAULT_WEBHOOK_RETRY_POLICY = Object.freeze({
  attempts: 2,
  baseDelayMs: 1_000,
});

// Validates a customer-supplied retry policy at configuration time. Returns
// the normalized policy, or throws with a clear message for out-of-range
// values (negative attempts, absurdly large backoff, non-integers).
export function validateWebhookRetryPolicy(policy) {
  if (policy === undefined || policy === null) return { ...DEFAULT_WEBHOOK_RETRY_POLICY };
  const { attempts, baseDelayMs } = policy;
  const b = WEBHOOK_RETRY_POLICY_BOUNDS;
  if (!Number.isInteger(attempts) || attempts < b.minAttempts || attempts > b.maxAttempts) {
    throw new Error(`webhook retry policy: attempts must be an integer in [${b.minAttempts}, ${b.maxAttempts}], got ${attempts}`);
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < b.minBaseDelayMs || baseDelayMs > b.maxBaseDelayMs) {
    throw new Error(`webhook retry policy: baseDelayMs must be an integer in [${b.minBaseDelayMs}, ${b.maxBaseDelayMs}], got ${baseDelayMs}`);
  }
  return { attempts, baseDelayMs };
}

// Comma-separated list of Soroban RPC endpoints, e.g.
// "https://primary.example.com,https://backup.example.com". The first entry
// is the primary; the rest are failover candidates used by
// stellarClient.js's getServerWithFailover() when the primary is degraded
// (see #147). Mirrors allowedOrigins's comma-split parsing convention.
const sorobanRpcUrls = (process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Deployment profile (#150). 'demo' is the disposable free-tier deployment
// documented in README's "Try it live" table; 'sandbox' is the long-lived
// developer sandbox environment that integrators point at. The profile only
// selects defaults below — every value stays overridable via its own env var
// so a single service can still be tuned without a code change.
const deploymentProfile = process.env.DEPLOYMENT_PROFILE === 'sandbox' ? 'sandbox' : 'demo';

// Rate-limit ceilings per profile (#150). The sandbox absorbs sustained
// integrator traffic rather than one-off demo hits, so it gets a more
// generous ceiling while still reusing the same rateLimit.js machinery.
const rateLimitDefaults = deploymentProfile === 'sandbox'
  ? { windowMs: 60_000, max: 600 }
  : { windowMs: 60_000, max: 120 };

export const config = Object.freeze({
  port: num(process.env.PORT, 4000),
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  // Primary RPC URL — kept for backward compatibility with existing callers
  // that read config.sorobanRpcUrl directly. Equals sorobanRpcUrls[0].
  sorobanRpcUrl: sorobanRpcUrls[0],
  // Full ordered list of configured RPC endpoints (primary first).
  sorobanRpcUrls: Object.freeze(sorobanRpcUrls),
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',

  // Which deployment this process is (#150): 'demo' (disposable) or
  // 'sandbox' (long-lived developer sandbox). Surfaced so /health and the
  // README can distinguish the two environments unambiguously.
  deploymentProfile,

  usdc: Object.freeze({
    sacId: process.env.USDC_SAC_ID || '',
    code: process.env.USDC_ASSET_CODE || 'USDC',
    issuer: process.env.USDC_ASSET_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }),

  contractId: process.env.ORACLE_CONTRACT_ID || '',
  platformSecret: process.env.PLATFORM_SECRET || '',
  platformAddress: process.env.PLATFORM_ADDRESS || '',

function parseApiChangelog(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_API_CHANGELOG;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_API_CHANGELOG;
  } catch {
    console.warn('[config] API_CHANGELOG_JSON is not valid JSON — falling back to the built-in changelog');
    return DEFAULT_API_CHANGELOG;
  }
}

// API version negotiation (#136). Additive, not a rewrite: every existing
// unversioned route in server.js keeps working unchanged and is treated as
// implicit v1, so no integrator is forced onto a /v1/ prefix. New or changed
// routes opt into an explicit version via either a URL-path prefix
// (/v2/...) or the Accept header (application/vnd.arbiter.v2+json).
//
// v1 is the implicit default (no version requested). v2 is the first
// explicitly negotiated version and is the real worked example for this
// issue. Requesting a version that isn't in this list must produce a clear
// 4xx (see negotiateApiVersion below) — never a silent fallback to v1 and
// never a 500.
export const API_VERSIONS = Object.freeze(['v1', 'v2']);
export const DEFAULT_API_VERSION = 'v1';

// Matches Accept: application/vnd.arbiter.v2+json (and the v1 form). Kept
// permissive about surrounding parameters (q-values, charset) since curl
// users won't hand-craft a perfect Accept header.
const ACCEPT_VERSION_RE = /application\/vnd\.arbiter\.(v\d+)\+json/i;

// Resolves the requested API version from a request's URL path and Accept
// header. Returns { version, explicit } where `explicit` is true only when
// the caller actually asked for a version (path prefix or Accept header) —
// unversioned requests resolve to DEFAULT_API_VERSION with explicit:false so
// callers can keep the legacy behavior byte-for-byte.
//
// Throws an Error with a `.status = 400` for an unrecognized version so the
// route layer can surface a clear 4xx instead of a silent fallback or 500.
export function negotiateApiVersion({ path = '', accept = '' } = {}) {
  const pathMatch = /^\/(v\d+)(?:\/|$)/i.exec(path);
  const acceptMatch = ACCEPT_VERSION_RE.exec(accept || '');
  const requested = (pathMatch?.[1] || acceptMatch?.[1] || '').toLowerCase();

  if (!requested) return { version: DEFAULT_API_VERSION, explicit: false };

  if (!API_VERSIONS.includes(requested)) {
    const err = new Error(
      `unsupported API version '${requested}'; supported versions: ${API_VERSIONS.join(', ')}`,
    );
    err.status = 400;
    err.code = 'unsupported_api_version';
    err.supportedVersions = API_VERSIONS;
    throw err;
  }

  return { version: requested, explicit: true };
}

// Contract-address rotation (#137). `config.contractId` used to be a single
// frozen env-var-driven string, so a contract redeployment required a full
// backend restart to reload it. It is now a live-reloadable value: the
// frozen `config` object still exposes `contractId` for backward
// compatibility, but every call site that must observe a rotation reads it
// through `getContractId()` instead of capturing the value once.
//
// `rotateContractId()` swaps the live value atomically (a single assignment,
// so no reader can observe a torn/partial value) and returns the previous id
// so callers can log/audit the cutover. Rotation is intentionally a plain
// in-process operation — the serial admin-call queue in stellarClient.js is
// responsible for draining in-flight calls against the old id before any new
// call uses it.
//
// Multi-contract support (#138) generalizes this: instead of exactly one
// active contract, a set of contract instances can be configured, each with
// its own admin key and its own serial admin-call queue (two instances that
// share a signing key don't need two queues, but independent keys do — see
// stellarClient.js). A new question is routed to one instance at
// `issueChallenge()` time and that choice is recorded in its stashed
// pendingQuestions record so verify/dispatch/resolve/refund all resolve the
// same instance. Selection is deliberately random/round-robin in v1 — no
// capacity awareness (explicitly out of scope).

// Parses the multi-contract configuration. Accepts either:
//   CONTRACT_INSTANCES_JSON='[{"id":"C...","adminKey":"S..."}, ...]'
// or a comma-separated CONTRACT_IDS='C...,C...' (each instance then shares
// the single platform admin key, so they share one serial queue). Falls back
// to the single legacy CONTRACT_ID so existing deployments keep working
// unchanged with exactly one instance.
function parseContractInstances() {
  const raw = process.env.CONTRACT_INSTANCES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const instances = parsed
          .map((entry, i) => {
            const id = typeof entry === 'string' ? entry : entry?.id;
            if (!id) return null;
            return {
              id,
              adminKey: (typeof entry === 'object' && entry?.adminKey) || process.env.ADMIN_SECRET_KEY || null,
              label: (typeof entry === 'object' && entry?.label) || `contract-${i}`,
            };
          })
          .filter(Boolean);
        if (instances.length > 0) return instances;
      }
    } catch {
      console.warn('[config] CONTRACT_INSTANCES_JSON is not valid JSON — falling back to CONTRACT_ID');
    }
  }

  const ids = (process.env.CONTRACT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length > 0) {
    return ids.map((id, i) => ({
      id,
      adminKey: process.env.ADMIN_SECRET_KEY || null,
      label: `contract-${i}`,
    }));
  }

  const single = process.env.CONTRACT_ID || '';
  return [{ id: single, adminKey: process.env.ADMIN_SECRET_KEY || null, label: 'contract-0' }];
}

  // Rate-limit ceilings (#150). Reuses the existing rateLimit.js machinery;
  // the sandbox profile gets a more generous default than the demo profile
  // since it absorbs sustained integrator traffic. Both windowMs and max
  // remain individually overridable via env for either profile.
  rateLimits: Object.freeze({
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, rateLimitDefaults.windowMs),
    max: num(process.env.RATE_LIMIT_MAX, rateLimitDefaults.max),
  }),

  worker: Object.freeze({
    rateLimitMaxConnections: num(process.env.WORKER_RATE_LIMIT_MAX_CONNECTIONS, 5),
    rateLimitWindowMs: num(process.env.WORKER_RATE_LIMIT_WINDOW_MS, 60_000),
    minAnswersBeforeReputationGate: num(process.env.WORKER_MIN_ANSWERS_BEFORE_REPUTATION_GATE, 5),
    minMatchRatio: num(process.env.WORKER_MIN_MATCH_RATIO, 0.2),
    // Once a worker crosses minAnswersBeforeReputationGate (has real accrued
    // earnings/reputation on the line), they must maintain at least this much
    // on-chain stake to keep receiving new questions — closes the "unstake to
    // zero, then misbehave for free" gap found pressure-testing the netting
    // engine. Past Owed earnings are never touched by this; it only gates
    // future dispatch eligibility. 0 (default) preserves today's behavior.
    minStakeStroops: BigInt(process.env.WORKER_MIN_STAKE_STROOPS || '0'),
  }),

  // Every one of these endpoints

/* … truncated 708 chars — edit only what you need near the top … */

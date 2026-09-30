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

// Graceful SESSION_SECRET rotation (#7): during a bounded grace window,
// session verification also accepts tokens signed by the immediately-prior
// secret (SESSION_SECRET_PREVIOUS). The window is measured from process
// start (i.e. from when the rotation was deployed). 0 disables it.
const SESSION_SECRET_PREVIOUS = process.env.SESSION_SECRET_PREVIOUS || '';
const SESSION_SECRET_ROTATION_GRACE_MS = num(process.env.SESSION_SECRET_ROTATION_GRACE_MS, 0);
const SESSION_SECRET_ROTATION_STARTED_AT = Date.now();

function sessionSecrets() {
  const secrets = [SESSION_SECRET];
  if (
    SESSION_SECRET_PREVIOUS &&
    SESSION_SECRET_PREVIOUS !== SESSION_SECRET &&
    SESSION_SECRET_ROTATION_GRACE_MS > 0 &&
    Date.now() - SESSION_SECRET_ROTATION_STARTED_AT < SESSION_SECRET_ROTATION_GRACE_MS
  ) {
    secrets.push(SESSION_SECRET_PREVIOUS);
  }
  return secrets;
}

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

// Contract compatibility pin (#163). This backend is developed independently
// of `arbiter-contract`, so nothing at build time guarantees the two agree on
// argument shapes. COMPATIBLE_CONTRACT_VERSION names the tagged contract
// release this backend is built against, and COMPATIBLE_CONTRACT_WASM_HASH is
// that release's recorded WASM hash (from arbiter-contract's release notes).
// At startup (see contractVersionCheck.js) the deployed instance's hash is
// fetched on-chain and compared against this pin; a mismatch logs a loud,
// specific warning rather than surfacing later as an opaque Soroban error.
// Compatibility model: same major version = safe; different major = verify
// manually against arbiter-contract's breaking-change definition.
export const contractCompatibility = Object.freeze({
  version: process.env.COMPATIBLE_CONTRACT_VERSION || '',
  wasmHash: (process.env.COMPATIBLE_CONTRACT_WASM_HASH || '').toLowerCase(),
});

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

  // Pinned arbiter-contract release this backend expects (see
  // contractCompatibility above and contractVersionCheck.js).
  compatibleContractVersion: contractCompatibility.version,
  compatibleContractWasmHash: contractCompatibility.wasmHash,

  // Must match the timeout_ledgers the contract was actually initialize()'d
  // with — this copy is for display/UX only (e.g. "auto-refund available
  // after ledger N"); the contract enforces its own stored value regardless.
  timeoutLedgers: num(process.env.TIMEOUT_LEDGERS, 100),

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

  // Cross-instance quorum collection (#160). When more than one backend
  // instance is running, a question's collector lives in the memory of
  // whichever instance dispatched it, but an answer for that question can
  // arrive at any instance a worker happens to be connected to. Answers are
  // therefore routed over Redis pub/sub: the owning instance subscribes to
  // `quorum:answers:<questionId>` and any instance that receives an answer
  // for a question it does not own publishes it there instead of dropping
  // it. Pub/sub (not Streams) is deliberate: answers are only useful while
  // the collector is still open, so replay/ordering guarantees buy nothing
  // here, and the simpler transport keeps the failure modes small. The
  // channel prefix is configurable so tests can namespace channels against a
  // shared fake Redis without colliding with a real deployment.
  quorum: Object.freeze({
    channelPrefix: process.env.QUORUM_CHANNEL_PREFIX || 'quorum:answers:',
    // How long an owning instance waits for a cross-instance answer before
    // treating the question as orphaned and letting the existing TTL/timeout
    // path refund it. Bounded by pendingQuestionTtlMs so a dead dispatcher
    // can never hold a question open longer than the normal pending TTL.
    answerTimeoutMs: num(process.env.QUORUM_ANSWER_TIMEOUT_MS, 30_000),
  }),

  // Comma-separated list of allowed CORS origins, e.g.
  // "https://app.example.com,https://demo.example.com". Defaults to '*'
  // (wide open) for local dev — lock this down for any real deployment.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  // Express `trust proxy` value, applied in server.js before any rate-limited
  // route registers. false (default) = trust nothing, req.ip is the raw
  // socket address (unchanged local-dev behavior). Behind Railway set
  // TRUST_PROXY=1 (exactly one proxy hop). See trustProxy() above for why
  // `true` is dangerous here.
  trustProxy: trustProxy(),

  // 'json' for real deployments (log aggregators parse JSON lines
  // directly); anything else pretty-prints for local dev readability.
  logFormat: process.env.LOG_FORMAT || 'pretty',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Prometheus scrape endpoint (metrics.js) and the probes behind its gauges
  // (healthProbes.js). METRICS_TOKEN unset = /metrics is open, which is the
  // usual setup for a scrape target on a private network.
  metrics: Object.freeze({
    token: process.env.METRICS_TOKEN || '',
    probeIntervalMs: num(process.env.METRICS_PROBE_INTERVAL_MS, 15_000),
    jobScanIntervalMs: num(process.env.METRICS_JOB_SCAN_INTERVAL_MS, 60_000),
  }),

  // Chain-driven recovery sweep (disasterRecovery.js): refunds on-chain
  // Pending questions that no local state can still settle, e.g. after the
  // store was lost. Needs contract v0.3.0+ (list_pending) and PLATFORM_SECRET.
  recovery: Object.freeze({
    enabled: process.env.RECOVERY_SWEEP_ENABLED !== 'false',
    intervalMs: num(process.env.RECOVERY_SWEEP_INTERVAL_MS, 5 * 60 * 1000),
    minAgeLedgers: num(process.env.RECOVERY_MIN_AGE_LEDGERS, 12),
    staleInflightMs: num(process.env.RECOVERY_STALE_INFLIGHT_MS, 30 * 60 * 1000),
    maxRefundsPerSweep: num(process.env.RECOVERY_MAX_REFUNDS_PER_SWEEP, 50),
  }),

  // Alert drill only (faultInjection.js). Refused in production by
  // securityPosture.js.
  faultInjection: process.env.ARBITER_FAULT_INJECTION === 'true',

  // Response security headers (see securityHeaders.js). CSP_CONNECT_SRC is a
  // comma-separated list of extra origins the frontend may fetch()/stream
  // from — only needed when the UI is hosted on a different origin than
  // this API. HSTS_ENABLED=false turns off Strict-Transport-Security.
  securityHeaders: Object.freeze({
    connectSrc: (process.env.CSP_CONNECT_SRC || '').split(',').map((s) => s.trim()).filter(Boolean),
    hsts: process.env.HSTS_ENABLED !== 'false',
  }),

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

  // Profanity/spam screen on worker answers (see answerFilter.js). A
  // rejected answer is never recorded in the quorum collector, so it can't
  // count toward consensus. Off by default; the blocklist is operator-
  // supplied (comma-separated) since what's unacceptable is audience-
  // specific. A negative maxLinks, or 0 for the other numeric limits,
  // disables that individual check.
  answerFilter: Object.freeze({
    enabled: process.env.ANSWER_FILTER_ENABLED === 'true',
    blocklist: Object.freeze(
      (process.env.ANSWER_FILTER_BLOCKLIST || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    maxLinks: num(process.env.ANSWER_FILTER_MAX_LINKS, 2),
    maxRepeatedChars: num(process.env.ANSWER_FILTER_MAX_REPEATED_CHARS, 10),
    maxUppercaseRatio: num(process.env.ANSWER_FILTER_MAX_UPPERCASE_RATIO, 0.8),
    // Short answers ("YES", "NO", "USA") are legitimately all-caps, so the
    // uppercase-ratio check only applies once an answer has this many letters.
    minLettersForCaseCheck: num(process.env.ANSWER_FILTER_MIN_LETTERS_FOR_CASE_CHECK, 20),
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
    minAnswersBeforeReputationGate: num(process.env.WORKER_MIN_ANSWERS_BEF

/* … truncated 1386 chars — edit only what you need near the top … */

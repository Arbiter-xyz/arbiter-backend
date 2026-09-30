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
    oracle: Object.freeze({
      max: num(process.env.ORACLE_RATE_LIMIT_MAX, 20),
      windowMs: num(process.env.ORACLE_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    sponsor: Object.freeze({
      max: num(process.env.SPONSOR_RATE_LIMIT_MAX, 10),
      windowMs: num(process.env.SPONSOR_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    answer: Object.freeze({
      max: num(process.env.ANSWER_RATE_LIMIT_MAX, 60),
      windowMs: num(process.env.ANSWER_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    // Sandbox mode is free (no real payment), so it needs its own — more
    // generous, but still real — limit rather than sharing the paid-flow
    // 'oracle' bucket, and rather than being unlimited.
    sandbox: Object.freeze({
      max: num(process.env.SANDBOX_RATE_LIMIT_MAX, 30),
      windowMs: num(process.env.SANDBOX_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    push: Object.freeze({
      max: num(process.env.PUSH_RATE_LIMIT_MAX, 10),
      windowMs: num(process.env.PUSH_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    billing: Object.freeze({
      max: num(process.env.BILLING_RATE_LIMIT_MAX, 10),
      windowMs: num(process.env.BILLING_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    webhooks: Object.freeze({
      max: num(process.env.WEBHOOKS_RATE_LIMIT_MAX, 20),
      windowMs: num(process.env.WEBHOOKS_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
    // Code minting/redemption and onboarding. Tight on purpose: each
    // redemption is a durable write, and onboarding builds a transaction
    // the platform would pay reserves for.
    referrals: Object.freeze({
      max: num(process.env.REFERRALS_RATE_LIMIT_MAX, 10),
      windowMs: num(process.env.REFERRALS_RATE_LIMIT_WINDOW_MS, 60_000),
    }),
  }),

  vapid: Object.freeze({
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  }),

  push: Object.freeze({
    // Push notifications supplement, never replace, the SSE dispatch
    // channel — they're for workers who aren't currently connected. A
    // push round-trip (deliver -> notice -> tap -> app loads) realistically
    // takes several seconds, so notifying for a very short quorum window
    // (e.g. the 'express' tier's 12s) would routinely arrive after the
    // window already closed. Below this threshold, skip push entirely
    // rather than notify workers for an opportunity they can't act on.
    minTimeoutForPushMs: num(process.env.PUSH_MIN_TIMEOUT_MS, 20_000),
  }),

  session: Object.freeze({
    secret: SESSION_SECRET,
    // How long a worker's session (proven once via a signed challenge
    // transaction) stays valid before they'd need to re-authenticate.
    ttlMs: num(process.env.WORKER_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
    // Graceful rotation: the set of secrets currently valid for verifying a
    // session token (current first, then the prior secret while the grace
    // window is open). Verification must accept a match from any of these;
    // signing always uses `secret`. Empty/absent previous secret or a 0
    // grace window yields a single-element list — identical to today.
    secrets: sessionSecrets,
    // Length of the rotation grace window in ms (0 = disabled).
    rotationGraceMs: SESSION_SECRET_ROTATION_GRACE_MS,
  }),

  // Single shared operator secret for the /admin/* console — this codebase
  // has no user-account system anywhere, so a bearer token is consistent
  // with everything else here. Multi-operator auth is a real follow-up,
  // not something to invent ahead of need.
  admin: Object.freeze({
    token: process.env.ADMIN_TOKEN || '',
  }),

  worker: Object.freeze({
    rateLimitMaxConnections: num(process.env.WORKER_RATE_LIMIT_MAX_CONNECTIONS, 5),
    rateLimitWindowMs: num(process.env.WORKER_RATE_LIMIT_WINDOW_MS, 60_000),
    minAnswersBeforeReputationGate: num(process.env.WORKER_MIN_ANSWERS_BEF

  // Settlement webhooks (see webhooks.js for registration/validation and
  // webhookDelivery.js for signing/retry). Delivery is best-effort and
  // never on the settlement path; these bound how hard it tries.
  webhooks: Object.freeze({
    maxPerOwner: num(process.env.WEBHOOK_MAX_PER_OWNER, 10),
    // Total delivery attempts per event, including the first one.
    maxAttempts: num(process.env.WEBHOOK_MAX_ATTEMPTS, 6),
    // Backoff before retry n is baseDelayMs * 2^(n-1) plus up to 20%
    // jitter: 5s, 10s, 20s, 40s, 80s by default, about 2.5 minutes in all.
    retryBaseDelayMs: num(process.env.WEBHOOK_RETRY_BASE_DELAY_MS, 5_000),
    timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10_000),
    // Local development / tests only: also accept http:// URLs and
    // loopback/private-network targets. Never enable in production, since
    // it turns webhook registration into an SSRF primitive against the
    // backend's own network.
    allowInsecureTargets: process.env.WEBHOOK_ALLOW_INSECURE_TARGETS === 'true',
    // Optional key (any string; it's hashed to 32 bytes) used to encrypt
    // signing secrets at rest with AES-256-GCM. Secrets must stay
    // recoverable, since signing needs the plaintext, so they can't be
    // hashed like API keys. Without a key they're stored as-is, which is the
    // same trust level as the store itself.
    secretEncryptionKey: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY || '',
  }),

  // Referral-based worker onboarding (see referrals.js). A worker mints one
  // code; new workers redeem it once, at onboarding time. The code is
  // bookkeeping plus a sybil speed bump, not a payout mechanism: there is no
  // on-chain referral reward, so nothing here moves money.
  referrals: Object.freeze({
    // Total redemptions one code allows. Bounds how far a single referrer
    // can fan out a ring of fresh identities under one code.
    maxUsesPerCode: num(process.env.REFERRAL_MAX_USES_PER_CODE, 25),
    // When true, POST /workers/:address/onboard refuses to build a
    // sponsored-onboarding transaction without a valid referral code.
    // Off by default so open onboarding keeps working as it does today.
    requiredForSponsoredOnboarding: process.env.REFERRAL_REQUIRED_FOR_SPONSORED_ONBOARDING === 'true',
  }),

  // Collusion-detection heuristics (see collusion.js). Every threshold is a
  // tunable heuristic, not a proof: flags are for operator review and for
  // denying the reconcile fast path, never for slashing on their own.
  collusion: Object.freeze({
    // Co-answered questions a pair needs before agreement-lift is scored at
    // all; below this, one lucky streak looks exactly like a ring.
    minSharedQuestions: num(process.env.COLLUSION_MIN_SHARED_QUESTIONS, 5),
    // Two answers landing within this window of each other count as
    // "synchronized" for the timing heuristic.
    syncWindowMs: num(process.env.COLLUSION_SYNC_WINDOW_MS, 1_500),
    // Pair score at or above which the pair is flagged for review and its
    // shared quorums lose the reconcile fast path.
    flagScore: num(process.env.COLLUSION_FLAG_SCORE, 0.6),
    // Pair score at or above which both workers are also dropped from
    // routing eligibility (soft, fails open like every other routing gate).
    suspendScore: num(process.env.COLLUSION_SUSPEND_SCORE, 0.85),
  }),
});

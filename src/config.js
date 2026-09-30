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

// Hand-maintained, structured source-of-truth for the public API changelog
// (#135). Deliberately NOT scraped from the README's narrative prose — each
// entry is a machine-readable record of a change to this server's HTTP
// surface, so integrators can diff versions programmatically. Kept as an
// explicit config value (overridable via API_CHANGELOG_JSON) rather than
// generated from git history, matching this codebase's bias toward simple,
// explicit config over inferred behavior. An empty/unset value is valid and
// must fail soft (see the /changelog route), never 500.
const DEFAULT_API_CHANGELOG = Object.freeze([
  {
    version: '1.0.0',
    date: '2024-01-01',
    changes: [
      {
        type: 'added',
        route: 'POST /oracle',
        description: 'Submit an oracle question. Initially a blocking call that returned the answer inline.',
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2024-02-01',
    changes: [
      {
        type: 'changed',
        route: 'POST /oracle',
        description: 'Became async-with-polling: returns a jobId immediately; results are fetched via GET /oracle/:jobId.',
      },
      {
        type: 'added',
        route: 'POST /oracle/metered',
        description: 'Separate metered submission path with its own rate limit and billing.',
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2024-03-01',
    changes: [
      {
        type: 'deprecated',
        route: 'POST /oracle/metered',
        description: 'Fused directly into POST /oracle in the round 7 "fuse pass". This route no longer exists; use POST /oracle.',
        sunset: '2024-03-01',
        replacement: 'POST /oracle',
      },
    ],
  },
]);

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

  // Subscription billing tier (#101). A single flat tier for now — prorated
  // upgrades/downgrades between tiers are explicitly out of scope. The
  // included volume is credited to the account's stroops balance on each
  // `invoice.paid` webhook (see billing.js's handleStripeWebhook), so it
  // flows through the same reserveCredit()/settleReservation() ledger as
  // one-shot credit and falls back to the existing insufficient-credit 402
  // path in POST /oracle once exhausted mid-cycle.
  subscription: Object.freeze({
    // Stripe Price id for the recurring tier. Empty disables the subscribe
    // endpoint (returns 503) rather than creating a session Stripe would
    // reject — same "unset means off" posture as contractId/platformSecret.
    priceId: process.env.SUBSCRIPTION_PRICE_ID || '',
    // Included volume per billing cycle, in stroops, credited on invoice.paid.
    includedVolumeStroops: BigInt(process.env.SUBSCRIPTION_INCLUDED_VOLUME_STROOPS || '0'),
    // Rollover policy for unused included volume at cycle end. Default false
    // (use-it-or-lose-it): each invoice.paid credits exactly
    // includedVolumeStroops, so a subscriber who under-consumes doesn't
    // accumulate an unbounded balance that later bypasses the metered
    // overage path. Set true to carry the remaining balance forward instead.
    // Like worker.minStakeStroops' "0 preserves today's behavior" framing,
    // this is an explicit, documented policy — not an accident of the order
    // in which invoice.paid happens to run.
    rolloverUnusedVolume: process.env.SUBSCRIPTION_ROLLOVER_UNUSED_VOLUME === 'true',
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

  // Every one of these endpoints either costs the platform a real network
  // fee per call (/sponsor/*) or writes unbounded state (/oracle), so all
  // get a per-IP rate limit, not just the SSE connection endpoint.
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
    //

/* … truncated 5869 chars — edit only what you need near the top … */

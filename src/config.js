import 'dotenv/config';
import { randomBytes } from 'node:crypto';

function num(v, d) {
  return v === undefined || v === '' ? d : Number(v);
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

export const config = Object.freeze({
  port: num(process.env.PORT, 4000),
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',

  // Structured API changelog served by GET /changelog (#135). Overridable via
  // API_CHANGELOG_JSON (a JSON array of version entries); defaults to the
  // built-in hand-maintained history above.
  apiChangelog: parseApiChangelog(process.env.API_CHANGELOG_JSON),

  // API version negotiation (#136). `versions` is the set of versions this
  // server will accept; `defaultVersion` is what an unversioned request
  // resolves to (implicit v1). Overridable via API_VERSIONS for operators
  // who want to add a version without a code change.
  apiVersions: Object.freeze(
    (process.env.API_VERSIONS || API_VERSIONS.join(','))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
  defaultApiVersion: process.env.DEFAULT_API_VERSION || DEFAULT_API_VERSION,

  usdc: Object.freeze({
    sacId: process.env.USDC_SAC_ID || '',
    code: process.env.USDC_ASSET_CODE || 'USDC',
    issuer: process.env.USDC_ASSET_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }),

  contractId: process.env.ORACLE_CONTRACT_ID || '',
  platformSecret: process.env.PLATFORM_SECRET || '',
  platformAddress: process.env.PLATFORM_ADDRESS || '',

  // Must match the timeout_ledgers the contract was actually initialize()'d
  // with — this copy is for display/UX only (e.g. "auto-refund available
  // after ledger N"); the contract enforces its own stored value regardless.
  timeoutLedgers: num(process.env.TIMEOUT_LEDGERS, 100),

  minConfidence: num(process.env.MIN_CONFIDENCE, 0.6),

  // Undo window (see undoWindow.js): how long a paid, non-instant question
  // is held after payment before it's dispatched to workers, during which
  // the payer can POST /oracle/:jobId/cancel for a refund. 0 disables it.
  undoWindowMs: num(process.env.UNDO_WINDOW_MS, 8_000),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // Draft-answer suggestions for human-quorum tiers (see oracle.js's
  // shouldDraftSuggestion): one extra Claude call per dispatched question,
  // delivered to workers as an unverified prefill. Opt-in, off by default:
  // it adds real per-question Claude spend, and a visible draft can anchor
  // workers toward the LLM's answer instead of their own independent one —
  // a trade-off an operator should choose deliberately, not inherit.
  draftSuggestions: Object.freeze({
    enabled: process.env.DRAFT_SUGGESTIONS_ENABLED === 'true',
    tiers: Object.freeze(
      (process.env.DRAFT_SUGGESTION_TIERS || 'standard,express,priority')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  }),

  pendingQuestionTtlMs: num(process.env.PENDING_QUESTION_TTL_MS, 600_000),
  jobResultTtlMs: num(process.env.JOB_RESULT_TTL_MS, 3_600_000),

  redisUrl: process.env.REDIS_URL || '',

  // Comma-separated list of allowed CORS origins, e.g.
  // "https://app.example.com,https://demo.example.com". Defaults to '*'
  // (wide open) for local dev — lock this down for any real deployment.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  // 'json' for real deployments (log aggregators parse JSON lines
  // directly); anything else pretty-prints for local dev readability.
  logFormat: process.env.LOG_FORMAT || 'pretty',
});

export { SESSION_SECRET };

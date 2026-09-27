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
// call uses the rotated one (see createSerialQueue).
let liveContractId = process.env.CONTRACT_ID || '';

export function getContractId() {
  return liveContractId;
}

export function rotateContractId(nextContractId) {
  if (typeof nextContractId !== 'string' || nextContractId === '') {
    throw new Error('rotateContractId: nextContractId must be a non-empty string');
  }
  const previous = liveContractId;
  liveContractId = nextContractId;
  return previous;
}

export const config = Object.freeze({
  port: num(process.env.PORT, 4000),
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',

  // Live-reloadable contract address (#137). This is the value at module
  // load; call sites that must observe a rotation should call
  // getContractId() rather than reading this frozen snapshot.
  contractId: liveContractId,

  // Structured API changelog served by GET /changelog (#135). Overridable via
  // API_CHANGELOG_JSON (a JSON array of version entries); defaults to the
  // built-in hand-maintained history above.
  apiChangelog: parseApiChangelog(process.env.API_CHANGELOG_JSON),

  // API version negotiation (#136). `versions` is the set of versions this
  // server will accept; `defaultVersion` is what an unversioned request
  // resolves to (implicit v1). Overridable via API_VERSIONS for operators
  // who 

/* … truncated 2880 chars — edit only what you need near the top … */

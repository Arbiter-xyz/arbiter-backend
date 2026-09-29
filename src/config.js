import 'dotenv/config';
import { randomBytes } from 'node:crypto';

function num(v, d) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ignoring malformed numeric value ${JSON.stringify(v)} — falling back to default ${d}`);
    return d;
  }
  return n;
}

// Express's `trust proxy` setting (see server.js's app.set('trust proxy', ...)).
// Without it, req.ip is always the immediate TCP peer address — behind a
// reverse proxy (Railway, nginx, a load balancer) that's the proxy's own
// address, so every per-IP rate limit in config.rateLimits and the SSE
// anti-sybil connection limit in dispatch.js collapse into one shared bucket.
//
// Defaults to false (trust nothing) so local dev is unchanged: req.ip is the
// raw socket address. For a real deployment, set TRUST_PROXY to the number of
// proxy hops in front of this process — typically `1` behind Railway (which
// terminates and proxies every connection exactly once). Never set this to
// `true`/`*` blindly: that trusts a client-supplied X-Forwarded-For header,
// letting any caller mint an independent rate-limit bucket per request.
function trustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return false;
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const hops = Number(trimmed);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // Anything else (a CIDR list, a named subnet, etc.) is passed through to
  // Express verbatim — it accepts those forms too.
  return trimmed;
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

// Data-retention policy engine (#128). Retention is declared per data type
// (identified by its store key prefix), not as a single global TTL — the
// modules that own each prefix have different durability requirements.
//
// `ttlMs` is the age at which a record becomes eligible for the sweep to
// purge. `null` means durable: the sweep will never touch it. Durable is the
// default for every prefix, and reputation/payer records are explicitly
// durable because deleting them would silently reset a worker's established
// status and weaken the sybil-resistance math in dispatch.js/reconcile.js.
// Aging those out is an explicit opt-in per data type, never a default.
export const RETENTION_POLICY = Object.freeze({
  // Job records already expire via config.jobResultTtlMs.
  'job:': Object.freeze({ ttlMs: num(process.env.RETENTION_JOB_TTL_MS, 3_600_000) }),
  // Pending-question stash already expires via config.pendingQuestionTtlMs.
  'pending-question:': Object.freeze({ ttlMs: num(process.env.RETENTION_PENDING_QUESTION_TTL_MS, 600_000) }),
  // Durable by design — see dispatch.js's isEstablishedWorker().
  'rep:': Object.freeze({ ttlMs: null }),
  // Durable by design — payer question history backs reconcile.js.
  'payer-questions:': Object.freeze({ ttlMs: null }),
  // Durable by design — anchor records are audit trail.
  'anchor-tx:': Object.freeze({ ttlMs: null }),
  'anchor-kyc:': Object.freeze({ ttlMs: null }),
});

// Resolves the retention rule for a store key by its prefix. Unknown
// prefixes are durable (never swept) — a new data type must opt in to
// expiry explicitly rather than inherit a default that could delete it.
export function retentionRuleFor(key) {
  if (typeof key !== 'string') return null;
  for (const prefix of Object.keys(RETENTION_POLICY)) {
    if (key.startsWith(prefix)) return RETENTION_POLICY[prefix];
  }
  return null;
}

export const config = Object.freeze({
  port: num(process.env.PORT, 4000),
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',

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

  // Retention sweep (#128). Mirrors dispatch.js's sweepWorkerTtls() shape:
  // a daily unref()'d setInterval that is explicitly skipped when
  // unconfigured ("don't pay for what isn't wired up"). Off by default.
  retention: Object.freeze({
    enabled: process.env.RETENTION_SWEEP_ENABLED === 'true',
    intervalMs: num(process.env.RETENTION_SWEEP_INTERVAL_MS, 86_400_000),
  }),

  redisUrl: process.env.REDIS_URL || '',

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

  // Admin console auth. `token` is the single shared bearer secret v1 ships
  // with (see adminAuth.js's requireAdmin). Multi-operator auth is a real
  // follow-up, not something to invent ahead of need.
  //
  // Second factor (#130): when `totpSecret` is set, requireAdmin additionally
  // demands a valid TOTP code (RFC 6238, Google-Authenticator-compatible)
  // alongside the bearer token. Unset means 2FA is off and the existing
  // single-token behavior is preserved exactly — the same
  // fail-closed-if-configured / unchanged-if-not pattern config.billing and
  // config.anchor use. The secret is never logged (see logger.js's
  // REDACT_CONFIG) and never echoed back in any response.
  admin: Object.freeze({
    token: process.env.ADMIN_TOKEN || '',
    totpSecret: process.env.ADMIN_TOTP_SECRET || '',
    // ±1 time-step tolerance (30s each) absorbs clock skew between the
    // operator's authenticator app and this server without widening the
    // replay window meaningfully.
    totpWindow: num(process.env.ADMIN_TOTP_WINDOW, 1),
  }),
});

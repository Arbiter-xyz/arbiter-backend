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

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // Fleet-wide (not per-IP) hard cost cap on real Claude API spend. Per-IP
  // rate limits (SANDBOX_RATE_LIMIT_MAX, ORACLE_RATE_LIMIT_MAX) bound a
  // single source, but a distributed attacker across many IPs can still
  // multiply real Anthropic spend arbitrarily. This rolling budget is
  // tracked in Redis (see costBudget.js) so it holds across every backend
  // instance, not just per-process. When exhausted, sandbox falls back to
  // canned/deterministic answers and the Instant tier fails closed to a
  // refund — never a hung or broken request. 0 disables the cap (preserves
  // today's behavior for local dev / tests).
  claudeCostBudget: Object.freeze({
    // Max real Claude API spend allowed per rolling window, in USD.
    maxUsd: num(process.env.CLAUDE_COST_BUDGET_USD, 0),
    // Length of the rolling window the budget is measured over.
    windowMs: num(process.env.CLAUDE_COST_BUDGET_WINDOW_MS, 3_600_000),
    // Conservative per-call cost estimate (USD) reserved before each real
    // Claude call, so concurrent in-flight calls can't collectively blow
    // past the cap before any of them report actual usage.
    estimatedCostPerCallUsd: num(process.env.CLAUDE_COST_PER_CALL_USD, 0.01),
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
  logLevel: process.env.LOG_LEVEL || 'info',

  // Response security headers (see securityHeaders.js). CSP_CONNECT_SRC is a
  // comma-separated list of extra origins the frontend may fetch()/stream
  // from — only needed when the UI is hosted on a different origin than
  // this API. HSTS_ENABLED=false turns off Strict-Transport-Security.
  securityHeaders: Object.freeze({
    connectSrc: (process.env.CSP_CONNECT_SRC || '').split(',').map((s) => s.trim()).filter(Boolean),
    hsts: process.env.HSTS_ENABLED !== 'false',
  }),

  maxQuestionLength: num(process.env.MAX_QUESTION_LENGTH, 2000),
  maxAnswerLength: num(process.env.MAX_ANSWER_LENGTH, 2000),

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

  // Home domain of the SEP-24/SEP-12 anchor Arbiter integrates with for
  // fiat rails (bank deposit/withdraw, KYC status). Arbiter is a CLIENT of
  // this anchor's stellar.toml — it never stores PII or bank details
  // itself. Unset disables the /anchor/* routes entirely.
  anchor: Object.freeze({
    homeDomain: process.env.ANCHOR_HOME_DOMAIN || '',
  }),

  // The non-crypto onramp (see billing.js): API-key customers pay in fiat
  // via Stripe and are settled on-chain from ONE pooled balance under this
  // dedicated identity — deliberately separate from platformSecret/
  // platformAddress above (which already collects platform fee revenue via
  // resolve()/refund()), so customer float and fee revenue never commingle
  // in one account. Unset disables the /billing/* routes and the API-key
  // branch of POST /oracle entirely (same fail-closed-if-unconfigured
  // posture as admin.token above).
  billing: Object.freeze({
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    fiatPoolSecret: process.env.FIAT_POOL_SECRET || '',
    fiatPoolAddress: process.env.FIAT_POOL_ADDRESS || '',
    // 1 USD = 1 USDC face value, at USDC's existing 7-decimal stroop
    // convention (see pricing.js's 

/* … truncated 320 chars — edit only what you need near the top … */

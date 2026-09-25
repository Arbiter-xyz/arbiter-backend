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

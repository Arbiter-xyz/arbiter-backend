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

// Supported fiat currencies for the Stripe onramp (#103). Each entry carries
// the number of minor units in one major unit (Stripe's `amount` is always
// in the currency's smallest unit) and the FX rate used to convert one major
// unit of that currency into USDC face value (which is what stroops are
// denominated in). USD is 1:1 by definition; the others are a
// periodically-updated static table — precision-to-the-cent isn't required
// for the onramp, and a static table avoids a live FX dependency on the
// checkout path. Rates are expressed as USDC-per-major-unit and are the
// source of truth for both checkout-time quoting and webhook-time crediting
// (the rate is snapshotted into session metadata at checkout so the webhook
// credits at the rate the customer actually saw).
export const SUPPORTED_FIAT_CURRENCIES = Object.freeze({
  usd: Object.freeze({ minorUnitsPerMajor: 100, usdcPerMajor: 1 }),
  eur: Object.freeze({ minorUnitsPerMajor: 100, usdcPerMajor: 1.08 }),
  gbp: Object.freeze({ minorUnitsPerMajor: 100, usdcPerMajor: 1.27 }),
  cad: Object.freeze({ minorUnitsPerMajor: 100, usdcPerMajor: 0.74 }),
  aud: Object.freeze({ minorUnitsPerMajor: 100, usdcPerMajor: 0.66 }),
});

// Normalizes and validates a caller-supplied currency code. Returns the
// lowercased ISO-4217 code, or throws for anything not in the supported
// table — callers (createCheckoutSession) turn that into a 400 rather than
// silently defaulting to USD.
export function normalizeFiatCurrency(currency) {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
    throw new Error(`unsupported currency: ${JSON.stringify(currency)}`);
  }
  const code = currency.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_FIAT_CURRENCIES, code)) {
    throw new Error(`unsupported currency: ${code}`);
  }
  return code;
}

// Converts an amount in a fiat currency's minor units (Stripe's `amount`)
// into stroops of USDC face value, using the given currency's locked-in FX
// rate. 1 USDC = 10_000_000 stroops. Used both at checkout time (to quote)
// and at webhook time (to credit), so the two can never disagree as long as
// the same rate is passed in.
export function fiatMinorUnitsToStroops(amountMinorUnits, currency) {
  const code = normalizeFiatCurrency(currency);
  const { minorUnitsPerMajor, usdcPerMajor } = SUPPORTED_FIAT_CURRENCIES[code];
  const majorUnits = Number(amountMinorUnits) / minorUnitsPerMajor;
  const usdc = majorUnits * usdcPerMajor;
  return BigInt(Math.round(usdc * 10_000_000));
}

// Chaos-engineering fault injection (#110). Env-gated following the same
// "everything is an env var with a safe default" convention as the rest of
// this file: with CHAOS_ENABLED unset (the default) the whole mechanism is
// inert — `chaos.enabled` is false and every consumer short-circuits before
// touching any injection state, so normal operation is byte-for-byte
// unaffected by the chaos code's mere presence. It is additionally refused
// outright when NODE_ENV=production, so a stray env var in a production
// deployment can never arm it. Scenarios are named seams matching the
// callers retry.js already wraps (stellarClient.js's runInvokeAsAdmin /
// simulateReadOnly, sponsor.js's relayFeeBump) plus the documented
// fail-closed outcomes a chaos run asserts on (e.g. a Soroban RPC timeout
// during resolveQuestion() must surface as a retryable failure, never a
// silent success).
const CHAOS_SCENARIOS = Object.freeze([
  'soroban_rpc_timeout',
  'horizon_unreachable',
  'redis_unreachable',
  'claude_timeout',
]);

function chaosConfig() {
  const requested = process.env.CHAOS_ENABLED === 'true';
  const isProduction = process.env.NODE_ENV === 'production';
  const enabled = requested && !isProduction;
  if (requested && isProduction) {
    console.warn('[config] CHAOS_ENABLED=true ignored: chaos fault injection is never reachable in production');
  }
  const scenario = (process.env.CHAOS_SCENARIO || '').trim();
  if (enabled && scenario && !CHAOS_SCENARIOS.includes(scenario)) {
    throw new Error(`chaos: unknown CHAOS_SCENARIO ${JSON.stringify(scenario)}; expected one of ${CHAOS_SCENARIOS.join(', ')}`);
  }
  return Object.freeze({
    enabled,
    scenario: enabled ? scenario : '',
    // Fraction of matching calls to fail, in [0, 1]. Defaults to 1 (every
    // matching call fails) so a scenario is deterministic unless a run
    // deliberately wants partial-failure behavior.
    failureRate: num(process.env.CHAOS_FAILURE_RATE, 1),
    // Injected latency for timeout scenarios, in ms.
    latencyMs: num(process.env.CHAOS_LATENCY_MS, 0),
    scenarios: CHAOS_SCENARIOS,
  });
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

  // Chaos-engineering fault injection (#110). Inert unless CHAOS_ENABLED=true
  // and NODE_ENV !== 'production'; see chaosConfig() above.
  chaos: chaosConfig(),

  // Comma-separated list of allowed CORS origins, e.g.
  // "https://app.example.com,https://demo.example.com". Defaults to '*'
  // (wide open) for local dev — lock this down for any real deployment.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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
    webhooks: Object.freeze({
      max: num(process.env.WEBHOOKS_RATE_LIMIT_MAX, 20),
      windowMs: num(process.env.WEBHOOKS_RATE_LIMIT_WINDOW_MS, 60_000),
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
    // convention (see pricing.js's stroopsToUsdc) — the simplest possible
    // conversion for v1. Stripe's own processing fee is absorbed by the
    // platform, not passed through to the credited balance; revisit if
    // margin matters before volume does.
    usdToStroops: 10_000_000n,
    minTopupUsd: num(process.env.MIN_TOPUP_USD, 10),
  }),

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

  // Auto-withdraw (see autoWithdraw.js). The backend can never sign a
  // worker's withdraw() itself, so "auto" means: once Owed crosses the
  // worker's threshold, prepare the unsigned withdraw transaction and push
  // it to them to sign. These bound how that runs.
  autoWithdraw: Object.freeze({
    // Floor on any worker-configured threshold, so nobody ends up with a
    // prepared transaction (and a notification) after every tiny credit.
    minThresholdStroops: BigInt(process.env.AUTO_WITHDRAW_MIN_THRESHOLD_STROOPS || '10000000'), // 1 USDC
    // How often the background sweep re-checks every opted-in worker's
    // Owed balance, on top of the check that runs right after settlement.
    // 0 disables the sweep (settlement-time checks still run).
    sweepIntervalMs: num(process.env.AUTO_WITHDRAW_SWEEP_INTERVAL_MS, 15 * 60 * 1000),
    // How long a prepared transaction stays valid for the worker to sign.
    // Also becomes the transaction's own time bound on-chain.
    pendingTtlMs: num(process.env.AUTO_WITHDRAW_PENDING_TTL_MS, 24 * 60 * 60 * 1000),
  }),

  // Annual earnings summary for tax reporting (see taxReport.js). The
  // payer block is the platform's own details, as they'd appear in the
  // PAYER box of a 1099. Unset fields are left blank in exports.
  tax: Object.freeze({
    // US reporting threshold in USD. At or above it, a summary is flagged
    // as reportable. $600 matches 1099-NEC; change it if your counsel says
    // a different form or threshold applies.
    reportingThresholdUsd: num(process.env.TAX_REPORTING_THRESHOLD_USD, 600),
    payerName: process.env.TAX_PAYER_NAME || '',
    payerTin: process.env.TAX_PAYER_TIN || '',
    payerAddress: process.env.TAX_PAYER_ADDRESS || '',
  }),
});

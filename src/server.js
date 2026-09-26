import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { issueChallengeIdempotent, verifyPayment, startFulfillment, getJobStatus, cancelJob } from './oracle.js';
import {
  onlineWorkerCount,
  checkConnectionRateLimit,
  registerWorker,
  unregisterWorker,
  submitAnswer,
  getReputation,
} from './dispatch.js';
import { getStats } from './stats.js';
import { getVapidPublicKey, isPushConfigured, saveSubscription, removeSubscription } from './push.js';
import { getPayerQuestionIds, summarizePayerQuestions, bucketPayerSpend } from './payerIndex.js';
import { requiresAuth, buildChallengeXdr, verifyChallengeAndIssueSession, verifySessionToken } from './workerAuth.js';
import {
  buildSponsoredOnboardTx,
  finalizeSponsoredOnboardTx,
  feeBumpSubmitPayment,
  feeBumpStake,
  feeBumpWithdraw,
  feeBumpWithdrawTo,
} from './sponsor.js';
import { getStashedQuestion, nextQuestionId } from './pendingQuestions.js';
import { getOwedOnChain, getStakeOnChain } from './stellarClient.js';
import { askMetered, getMeteredBalance, depositInstructions } from './metered.js';
import { getLeaderboard } from './leaderboard.js';
import { stroopsToUsdc, resolveTier, MAX_SURGE_MULTIPLIER } from './pricing.js';
import { checkRateLimit } from './rateLimit.js';
import { issueSandboxChallenge, startSandboxFulfillment } from './sandbox.js';
import { requireAdmin } from './adminAuth.js';
import { listTransactions, listWorkers, listPayers, getTreasury, getFeeRevenue, listAnchorPayouts, listAnchorKyc } from './admin.js';
import { getAnchorConfig, isAnchorConfigured } from './anchorClient.js';
import { recordAnchorTransaction, recordAnchorKyc } from './anchorRecords.js';
import { resolveApiKey } from './apiKeyAuth.js';
import { parseConsensusRule } from './consensus.js';
import { getPrivatePool, addPoolWorkers, removePoolWorkers, PoolValidationError } from './privatePools.js';
import { isBillingConfigured, createCheckoutSession, handleStripeWebhook, getCreditBalanceStroops, reserveCredit, settleReservation } from './billing.js';
import { registerWebhook, listWebhooks, deleteWebhook, WebhookError } from './webhooks.js';
import { logger, httpLogger } from './logger.js';
import { getProvenance } from './provenance.js';
import { enforceSecurityPosture } from './securityPosture.js';
import { metricsMiddleware, metricsHandler, buildInfo } from './metrics.js';
import { startHealthProbes } from './healthProbes.js';
import { createFaultInjector, mountFaultRoutes } from './faultInjection.js';
import { runRecoverySweep, defaultRecoveryDeps, startRecoverySweeper } from './disasterRecovery.js';
import { store } from './store.js';
import { getKnownJobIds, getJob } from './jobs.js';
import { getLatestLedgerSequence } from './stellarClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Refuse to boot a real deployment that left a severe insecure default in
// place, and log loudly about the rest — see securityPosture.js. Local dev
// with every default untouched passes silently.
if (!enforceSecurityPosture(process.env, logger)) {
  console.error('[security-posture] refusing to start: fix the setting(s) named above.');
  await new Promise((resolve) => logger.flush(resolve));
  process.exit(1);
}

const app = express();
// One structured log line per request (method/path/status/duration/request
// id), and req.log is available in every handler below for attaching
// further context (questionId, workerId, etc.) to that same request's
// trace. Placed before every other middleware so nothing is unlogged.
app.use(httpLogger);

// Request count/latency by matched route for GET /metrics (see metrics.js
// and ops/observability/). Before every route so nothing is uncounted —
// including requests failed by the fault injector just below.
app.use(metricsMiddleware);

// Alert drill only (scripts/alert-drill.js); securityPosture.js refuses to
// start a production deployment with this on.
const faultInjector = config.faultInjection ? createFaultInjector() : null;
if (faultInjector) {
  logger.warn('ARBITER_FAULT_INJECTION=true: /admin/faults can inject HTTP errors and latency');
  app.use(faultInjector.middleware);
}

// Security response headers on every response (API and static UI alike).
app.use(securityHeadersMiddleware());

// Wide open ('*') by default for local dev; set ALLOWED_ORIGINS to a
// comma-separated list to lock this down for a real deployment. Wide-open
// CORS combined with unlimited requests is what makes any-origin request
// flooding possible in the first place, so this is paired with the rate
// limiting below, not a substitute for it.
app.use(cors(config.allowedOrigins.includes('*') ? { origin: '*' } : { origin: config.allowedOrigins }));

// Stripe webhook signature verification needs the RAW request body, and
// Express only hands raw bytes to whichever parser claims a request first
// — so this route (and only this one) must be registered with its own
// express.raw() BEFORE the global express.json() below, or the body would
// already be parsed/mangled by the time constructEvent() sees it.
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!isBillingConfigured()) return res.status(503).json({ error: 'billing not configured' });
  try {
    await handleStripeWebhook(req.body, req.get('stripe-signature'));
    res.json({ received: true });
  } catch (err) {
    req.log.warn({ err }, 'stripe webhook signature verification failed');
    res.status(400).json({ error: 'invalid webhook signature' });
  }
});

app.use(express.json());

/** Every /sponsor/* call spends a real network fee on the platform's behalf,
 * and POST /oracle writes unbounded state per call — both get a per-IP rate
 * limit, not just the SSE connection endpoint. */
function rateLimited(bucket, keyFn) {
  return async (req, res, next) => {
    const { max, windowMs } = config.rateLimits[bucket];
    const allowed = await checkRateLimit(`${bucket}:${keyFn(req)}`, max, windowMs);
    if (!allowed) {
      return res.status(429).json({ error: `rate limit exceeded for ${bucket}, try again shortly` });
    }
    next();
  };
}
const byIp = (req) => req.ip;

app.get('/metrics', metricsHandler({ token: config.metrics.token }));

app.get('/health', (req, res) => {
  res.json({ ok: true, onlineWorkers: onlineWorkerCount(), contractId: config.contractId });
});

// Platform-wide, real-settlement-only counters — safe to surface publicly
// (e.g. a landing page trust strip) since sandbox traffic never counts
// toward these (see stats.js).
// Public, no auth, no wallet — worker reputation as a portable asset rather
// than a number this backend keeps behind a login. Match ratio is this
// backend's own record (stated plainly, not independently verifiable);
// stake is read live from the contract, so at least that part of every row
// is checkable by anyone without trusting this API at all.
app.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const leaderboard = await getLeaderboard(limit);
    res.json({ leaderboard });
  } catch (err) {
    req.log.error({ err }, 'failed to build leaderboard');
    res.status(500).json({ error: 'failed to build leaderboard' });
  }
});

app.get('/stats', async (req, res) => {
  const stats = await getStats();
  res.json({ onlineWorkers: onlineWorkerCount(), ...stats });
});

// ---------------------------------------------------------------------
// POST /oracle — two-step HTTP 402 flow, now resolving asynchronously.
// Step 1 (no payment headers): issue a 402 challenge.
// Step 2 (X-Payment-Tx / X-Question-Id present): verify payment on-chain,
// then return 202 immediately and settle in the background. Poll
// GET /oracle/:jobId for the outcome.
// ---------------------------------------------------------------------

// Sandbox mode: zero payment, zero chain, zero LLM — a single call that
// returns a fully realistic job to poll. Rate-limited on its own (more
// generous than the paid flow, but not unlimited) since it's free to call.
app.post('/oracle/sandbox', rateLimited('sandbox', byIp), async (req, res) => {
  const { question, tier, simulate } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'body.question (string) is required' });
  }
  if (question.length > config.maxQuestionLength) {
    return res.status(400).json({ error: `body.question must be at most ${config.maxQuestionLength} characters` });
  }
  try {
    const questionId = (await nextQuestionId()).toString();
    const challenge = issueSandboxChallenge(questionId, question, tier);
    const { jobId } = await startSandboxFulfillment(questionId, question, { tierKey: tier, simulate });
    return res.status(202).json({ ...challenge, jobId, statusUrl: `/oracle/${jobId}` });
  } catch (err) {
    req.log.error({ err }, 'sandbox failed to start');
    return res.status(500).json({ error: 'failed to start sandbox request' });
  }
});

/**
 * ONE endpoint, two payment methods chosen transparently by what the
 * caller sends — not two parallel APIs to learn. Include `payerAddress` +
 * `token` (from POST /payers/:address/session) and a sufficient prepaid
 * balance, and this settles immediately with no 402 round trip and no
 * per-question signature at all. Send nothing extra, and it's the classic
 * flow: 402 with payment instructions, then retry with X-Payment-Tx after
 * a real submit(). Metered billing was originally a separate
 * /oracle/metered route; fusing it into /oracle itself is the point —
 * "how you pay" shouldn't be a different URL than "what you're asking."
 */
app.post('/oracle', rateLimited('oracle', byIp), async (req, res) => {
  const questionId = req.header('X-Question-Id');
  const paymentTx = req.header('X-Payment-Tx');
  const { question, tier, category, payerAddress, token, consensusMode, tolerance } = req.body || {};
  // Only checked on the paths that create a question — step 2 of the
  // classic flow reuses the rule already stashed at step 1.
  const consensus = parseConsensusRule({ consensusMode, tolerance });

  // Third payment method: an `Authorization: Bearer ak_live_...` API key
  // (see apiKeyAuth.js/billing.js) — the wallet-free onramp. Checked first
  // since it needs neither payerAddress nor a session token; everything
  // downstream (dispatch, reconcile, settle) is the identical pipeline,
  // funded from the platform's own pooled balance instead of the caller's.
  const apiKeyAccountId = await resolveApiKey(req);
  if (apiKeyAccountId) {
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'body.question (string) is required' });
    }
    if (question.length > config.maxQuestionLength) {
      return res.status(400).json({ error: `body.question must be at most ${config.maxQuestionLength} characters` });
    }
    if (!consensus.ok) return res.status(400).json({ error: consensus.error });

    // Reserve the worst-case (surge-capped) price up front — askMetered()
    // only reveals the real, possibly-lower price it actually charged
    // after the on-chain charge has already happened, so the reservation
    // has to cover the ceiling, not the (not-yet-known) actual. See
    // reserveCredit()'s doc comment in billing.js.
    const resolvedTier = resolveTier(tier);
    const maxStroops = Number(resolvedTier.priceStroops * BigInt(MAX_SURGE_MULTIPLIER));
    let reserved;
    try {
      reserved = await reserveCredit(apiKeyAccountId, maxStroops);
    } catch (err) {
      // An Express 4 async handler doesn't catch a throw on its own — left
      // unguarded, this would be an unhandled rejection that crashes the
      // whole process, not just fail this one request.
      req.log.error({ err, apiKeyAccountId }, 'credit reservation failed unexpectedly');
      return res.status(500).json({ error: 'failed to process request' });
    }
    if (!reserved) {
      return res.status(402).json({ error: 'insufficient credit balance — top up via POST /billing/checkout' });
    }

    try {
      const result = await askMetered(config.billing.fiatPoolAddress, question, tier, category, {
        ownerAccountId: apiKeyAccountId, // routes this customer's settlement webhooks
      });
      await settleReservation(apiKeyAccountId, maxStroops, Number(result.amountStroops));
      return res.status(202).json({ ...result, statusUrl: `/oracle/${result.jobId}` });
    } catch (err) {
      // Refund the reservation in full — this failure is the platform's
      // pooled float running low, never the customer's fault, so it should
      // never cost them credit. Never surfaced to the customer as "the
      // platform is low on funds" — that's an operator concern (see the
      // Treasury admin view), not something to leak externally.
      await settleReservation(apiKeyAccountId, maxStroops, 0);
      req.log.error({ err, apiKeyAccountId }, 'fiat-pool charge failed — platform pooled balance may be low');
      return res.status(503).json({ error: 'temporarily unable to process — try again shortly' });
    }
  }

  if (payerAddress) {
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'body.question (string) is required' });
    }
    if (question.length > config.maxQuestionLength) {
      return res.status(400).json({ error: `body.question must be at most ${config.maxQuestionLength} characters` });
    }
    if (verifySessionToken(token) !== payerAddress) {
      return res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session' });
    }
    if (!consensus.ok) return res.status(400).json({ error: consensus.error });
    try {
      const result = await askMetered(payerAddress, question, tier, category, consensus.rule);
      return res.status(202).json({ ...result, statusUrl: `/oracle/${result.jobId}` });
    } catch (err) {
      // #13 is ContractError::InsufficientBalance — see contracts/oracle-escrow/src/lib.rs.
      // Simulation failures surface the raw Soroban error string, not a typed
      // exception, so this is the same string-matching pattern stellarClient.js
      // already uses for QuestionNotFound.
      if (/Error\(Contract, #13\)/.test(err.message || '')) {
        return res.status(402).json({
          error: 'insufficient prepaid balance',
          ...depositInstructions(payerAddress),
        });
      }
      req.log.error({ err, payerAddress }, 'metered charge failed');
      return res.status(500).json({ error: 'failed to process metered request' });
    }
  }

  if (!questionId || !paymentTx) {
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'body.question (string) is required' });
    }
    if (question.length > config.maxQuestionLength) {
      return res.status(400).json({ error: `body.question must be at most ${config.maxQuestionLength} characters` });
    }
    if (!consensus.ok) return res.status(400).json({ error: consensus.error });
    try {
      const challenge = await issueChallengeIdempotent(question, tier, category, req.header('Idempotency-Key'), consensus.rule);
      return res.status(402).json(challenge);
    } catch (err) {
      req.log.error({ err }, 'failed to issue challenge');
      return res.status(500).json({ error: 'failed to issue payment challenge' });
    }
  }

  try {
    const verdict = await verifyPayment(questionId);
    if (!verdict.ok) {
      return res.status(verdict.status).json({ questionId, reason: verdict.reason });
    }

    const { jobId, cancellableUntil } = await startFulfillment(questionId, verdict.pending, verdict.tier, verdict.payerAddress);
    return res.status(202).json({
      jobId,
      questionId,
      question: verdict.pending.question,
      statusUrl: `/oracle/${jobId}`,
      ...(cancellableUntil ? { cancellableUntil, cancelUrl: `/oracle/${jobId}/cancel` } : {}),
      quorumSize: verdict.tier.quorumSize,
      timeoutMs: verdict.tier.timeoutMs,
    });
  } catch (err) {
    req.log.error({ err, questionId }, 'failed to process payment/fulfillment');
    return res.status(500).json({ error: 'failed to process payment' });
  }
});

// ---------------------------------------------------------------------
// Payer identity for metered billing (POST /oracle above) — deposit()
// once on-chain (a real payer signature, made out of band), then ask any
// number of questions with no further signing. Reuses workerAuth.js's
// challenge/response session mechanism to prove control of the payer
// address; the token itself doesn't distinguish "worker" from "payer"
// (both just prove control of a Stellar address), only the route naming
// does.
// ---------------------------------------------------------------------

app.post('/payers/:address/session/challenge', rateLimited('push', byIp), async (req, res) => {
  try {
    const xdr = await buildChallengeXdr(req.params.address);
    res.json({ xdr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/payers/:address/session', rateLimited('push', byIp), async (req, res) => {
  const { signedXdr } = req.body || {};
  if (!signedXdr) return res.status(400).json({ error: 'signedXdr is required' });
  const session = await verifyChallengeAndIssueSession(req.params.address, signedXdr);
  if (!session) return res.status(401).json({ error: 'challenge verification failed — signature did not match, or the challenge expired' });
  res.json(session);
});

app.get('/payers/:address/balance', async (req, res) => {
  if (requiresAuth(req.params.address) && verifySessionToken(req.query.token) !== req.params.address) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session' });
  }
  try {
    const balance = await getMeteredBalance(req.params.address);
    res.json({ ...balance, ...depositInstructions(req.params.address) });
  } catch (err) {
    req.log.error({ err }, 'failed to read prepaid balance');
    res.status(500).json({ error: 'failed to read prepaid balance' });
  }
});

app.get('/oracle/:jobId', async (req, res) => {
  const job = await getJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown or expired jobId' });
  const httpStatus = job.status === 'settled' ? 200 : 202;
  return res.status(httpStatus).json({ jobId: req.params.jobId, ...job });
});

// Public, unauthenticated, same as GET /oracle/:jobId: the full committed
// reconciliation inputs for a settled question (raw worker submissions, the
// exact LLM request/response when one was used), the sha256 commitment, and
// the settlement tx hashes. See provenance.js for the format, and
// scripts/verify-provenance.js to re-derive the consensus independently.
app.get('/oracle/:jobId/provenance', async (req, res) => {
  const entry = await getProvenance(req.params.jobId);
  if (!entry) return res.status(404).json({ error: 'no provenance recorded for this jobId (not settled yet, or settled before provenance existed)' });
  return res.json({
    jobId: req.params.jobId,
    algorithm: 'sha256',
    canonicalization: 'RFC 8785 (JCS)',
    hash: entry.hash,
    record: entry.record,
    settlement: entry.settlement,
  });
});

// A payer's own question history — there's no account system, so this is
// keyed purely by the payer's on-chain address (recorded the moment their
// payment is verified, see oracle.js::verifyPayment). Job records expire
// after JOB_RESULT_TTL_MS same as everything else in jobs.js, so very old
// entries in the index may resolve to nothing — filtered out below rather
// than surfaced as broken rows.
app.get('/payers/:address/questions', async (req, res) => {
  if (requiresAuth(req.params.address) && verifySessionToken(req.query.token) !== req.params.address) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session' });
  }
  const ids = await getPayerQuestionIds(req.params.address);
  const jobs = await Promise.all(ids.map((id) => getJobStatus(id)));
  const summary = summarizePayerQuestions(ids, jobs);
  const { spendByCategory, spendByDay } = bucketPayerSpend(summary.questions);

  res.json({
    questions: summary.questions,
    totalTracked: summary.totalTracked,
    totalSpendStroops: summary.totalSpendStroops.toString(),
    totalSpend: stroopsToUsdc(summary.totalSpendStroops),
    successRate: summary.successRate,
    spendByCategory,
    spendByDay,
  });
});

// ---------------------------------------------------------------------
// Private worker pools — a payer's whitelist of worker addresses. When
// one exists, that payer's questions are only dispatched to (and only
// accept answers from) those workers; see privatePools.js for storage and
// oracle.js's fulfillOracleCall() for enforcement. Unlike the other
// per-address routes, a session token is ALWAYS required, even for a
// non-address id: a pool changes where a payer's questions go, so there's
// no test-string convenience to preserve here.
// ---------------------------------------------------------------------

function requirePoolOwner(req, res, token) {
  if (!requiresAuth(req.params.address)) {
    res.status(400).json({ error: 'pool owner must be a valid Stellar address' });
    return false;
  }
  if (verifySessionToken(token) !== req.params.address) {
    res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session' });
    return false;
  }
  return true;
}

async function handlePoolWrite(req, res, mutate) {
  try {
    const workers = await mutate();
    res.json({ payerAddress: req.params.address, workers, size: workers.length });
  } catch (err) {
    if (err instanceof PoolValidationError) return res.status(400).json({ error: err.message });
    req.log.error({ err }, 'private pool update failed');
    res.status(500).json({ error: 'failed to update private pool' });
  }
}

app.get('/payers/:address/pool', async (req, res) => {
  if (!requirePoolOwner(req, res, req.query.token)) return;
  try {
    const workers = await getPrivatePool(req.params.address);
    res.json({ payerAddress: req.params.address, workers, size: workers.length });
  } catch (err) {
    req.log.error({ err }, 'private pool read failed');
    res.status(500).json({ error: 'failed to read private pool' });
  }
});

// body: { token, workers: [address, ...] }
app.post('/payers/:address/pool', rateLimited('push', byIp), async (req, res) => {
  const { token, workers } = req.body || {};
  if (!requirePoolOwner(req, res, token)) return;
  await handlePoolWrite(req, res, () => addPoolWorkers(req.params.address, workers));
});

// Removes one worker. Token goes in the query string, same as the GET,
// since DELETE bodies aren't reliably passed through by proxies.
app.delete('/payers/:address/pool/:worker', rateLimited('push', byIp), async (req, res) => {
  if (!requirePoolOwner(req, res, req.query.token)) return;
  await handlePoolWrite(req, res, () => removePoolWorkers(req.params.address, [req.params.worker]));
});

// ---------------------------------------------------------------------
// Billing — the non-crypto onramp. /billing/webhook is registered above,
// before express.json(), since it needs the raw request body. Everything
// here is a no-op 503 when billing isn't configured (see
// isBillingConfigured in billing.js) rather than a crash, same
// fail-closed-if-unconfigured posture as /admin/* and /anchor/*.
// ---------------------------------------------------------------------

app.post('/billing/checkout', rateLimited('billing', byIp), async (req, res) => {
  if (!isBillingConfigured()) return res.status(503).json({ error: 'billing not configured' });
  const { amountUsd, successUrl, cancelUrl } = req.body || {};
  if (!successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'successUrl and cancelUrl are required' });
  }
  try {
    const result = await createCheckoutSession(Number(amountUsd), successUrl, cancelUrl);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'failed to create checkout session' });
  }
});

app.get('/billing/account', async (req, res) => {
  const accountId = await resolveApiKey(req);
  if (!accountId) return res.status(401).json({ error: 'a valid API key is required' });
  const creditBalanceStroops = await getCreditBalanceStroops(accountId);
  res.json({ accountId, creditBalanceStroops: String(creditBalanceStroops), creditBalance: stroopsToUsdc(creditBalanceStroops) });
});

// ---------------------------------------------------------------------
// Settlement webhooks — instead of polling GET /oracle/:jobId, an owner
// registers a URL that receives a signed POST when each of their questions
// settles (delivery/signing: webhookDelivery.js). An owner is either:
//   - an API-key customer: `Authorization: Bearer ak_live_...`, or
//   - a wallet payer: `address` + session `token` (from
//     POST /payers/:address/session), in the JSON body or query string,
//     the same proof every other payer-scoped route requires.
// Only real Stellar addresses qualify on the payer side (the test-string
// id convenience other routes allow doesn't apply). A webhook delivers
// data, so the owner must be proven.
// ---------------------------------------------------------------------

async function resolveWebhookOwner(req) {
  const accountId = await resolveApiKey(req);
  if (accountId) return `account:${accountId}`;
  const address = req.body?.address ?? req.query.address;
  const token = req.body?.token ?? req.query.token;
  if (typeof address === 'string' && requiresAuth(address) && verifySessionToken(token) === address) {
    return `payer:${address}`;
  }
  return null;
}

const WEBHOOK_AUTH_ERROR =
  'authenticate with an API key (Authorization: Bearer ak_live_...) or a payer address + session token — see POST /payers/:address/session';

app.post('/webhooks', rateLimited('webhooks', byIp), async (req, res) => {
  const owner = await resolveWebhookOwner(req);
  if (!owner) return res.status(401).json({ error: WEBHOOK_AUTH_ERROR });
  try {
    const { url, description } = req.body || {};
    const webhook = await registerWebhook(owner, url, { description });
    // The signing secret appears in this response and nowhere else, ever.
    res.status(201).json({
      ...webhook,
      note: 'Store `secret` now — it is never shown again. Verify each delivery\'s X-Arbiter-Signature with it (see README "Webhooks").',
    });
  } catch (err) {
    if (err instanceof WebhookError) return res.status(err.status).json({ error: err.message });
    req.log.error({ err }, 'failed to register webhook');
    res.status(500).json({ error: 'failed to register webhook' });
  }
});

app.get('/webhooks', rateLimited('webhooks', byIp), async (req, res) => {
  const owner = await resolveWebhookOwner(req);
  if (!owner) return res.status(401).json({ error: WEBHOOK_AUTH_ERROR });
  res.json({ webhooks: await listWebhooks(owner) });
});

app.delete('/webhooks/:id', rateLimited('webhooks', byIp), async (req, res) => {
  const owner = await resolveWebhookOwner(req);
  if (!owner) return res.status(401).json({ error: WEBHOOK_AUTH_ERROR });
  // 404 for someone else's webhook too, so ids can't be probed across owners.
  const deleted = await deleteWebhook(owner, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'no such webhook' });
  res.json({ ok: true, id: req.params.id });
});

// ---------------------------------------------------------------------
// Gas sponsorship — payers and workers never need to hold XLM. Every route
// here costs the platform a real fee-bump, so all are rate-limited.
// ---------------------------------------------------------------------

app.post('/sponsor/onboard/build', rateLimited('sponsor', byIp), async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  try {
    const xdr = await buildSponsoredOnboardTx(address);
    res.json({ xdr });
  } catch (err) {
    req.log.error({ err }, 'sponsor onboard/build failed');
    res.status(500).json({ error: err.message });
  }
});

app.post('/sponsor/onboard/submit', rateLimited('sponsor', byIp), async (req, res) => {
  const { xdr } = req.body || {};
  if (!xdr) return res.status(400).json({ error: 'xdr is required' });
  try {
    const result = await finalizeSponsoredOnboardTx(xdr);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'sponsor onboard/submit failed');
    res.status(500).json({ error: err.message });
  }
});

app.post('/sponsor/pay', rateLimited('sponsor', byIp), async (req, res) => {
  const { xdr, payerAddress, questionId } = req.body || {};
  if (!xdr || !payerAddress || !questionId) {
    return res.status(400).json({ error: 'xdr, payerAddress, and questionId are required' });
  }
  try {
    const pending = await getStashedQuestion(questionId);
    if (!pending) return res.status(400).json({ error: 'unknown or expired questionId' });
    // Use the price actually quoted (snapshotted at issueChallenge time under
    // surge pricing), not a freshly recomputed one.
    const result = await feeBumpSubmitPayment(xdr, payerAddress, questionId, pending.priceStroops);
    res.json(result);
  } catch (err) {
    // Deliberately 400, not 500 — a rejected fee-bump is almost always the
    // security check refusing a malformed/mismatched inner transaction.
    req.log.error({ err }, 'sponsor pay failed');
    res.status(400).json({ error: err.message });
  }
});

app.post('/sponsor/stake', rateLimited('sponsor', byIp), async (req, res) => {
  const { xdr, workerAddress, amountStroops } = req.body || {};
  if (!xdr || !workerAddress || !amountStroops) {
    return res.status(400).json({ error: 'xdr, workerAddress, and amountStroops are required' });
  }
  try {
    const result = await feeBumpStake(xdr, workerAddress, amountStroops);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'sponsor stake failed');
    res.status(400).json({ error: err.message });
  }
});

app.post('/sponsor/withdraw', rateLimited('sponsor', byIp), async (req, res) => {
  const { xdr, workerAddress, amountStroops, beneficiaryAddress } = req.body || {};
  if (!xdr || !workerAddress || !amountStroops) {
    return res.status(400).json({ error: 'xdr, workerAddress, and amountStroops are required' });
  }
  try {
    // beneficiaryAddress is opt-in: present -> the worker signed a
    // withdraw_to() call routing the payout elsewhere; absent -> the
    // ordinary withdraw() call paying the worker's own address.
    const result = beneficiaryAddress
      ? await feeBumpWithdrawTo(xdr, workerAddress, beneficiaryAddress, amountStroops)
      : await feeBumpWithdraw(xdr, workerAddress, amountStroops);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'sponsor withdraw failed');
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Worker on-chain balances — accrued earnings and staked bond.
// ---------------------------------------------------------------------

app.get('/workers/:address/owed', async (req, res) => {
  try {
    const owedStroops = await getOwedOnChain(req.params.address);
    res.json({ owedStroops: owedStroops.toString(), owed: stroopsToUsdc(owedStroops) });
  } catch (err) {
    req.log.error({ err }, 'worker owed lookup failed');
    res.status(500).json({ error: err.message });
  }
});

app.get('/workers/:address/stake', async (req, res) => {
  try {
    const stakeStroops = await getStakeOnChain(req.params.address);
    res.json({ stakeStroops: stakeStroops.toString(), stake: stroopsToUsdc(stakeStroops) });
  } catch (err) {
    req.log.error({ err }, 'worker stake lookup failed');
    res.status(500).json({ error: err.message });
  }
});

// A worker's own track record — this data already drove the reputation
// gate and the reconciliation fast path internally; it was never actually
// shown to the worker it's about. Surfacing it directly addresses "workers
// can't see their own progress," one of the retention gaps identified in
// the UX pass.
app.get('/workers/:address/reputation', async (req, res) => {
  const rep = await getReputation(req.params.address);
  const matchRatio = rep.total > 0 ? rep.matched / rep.total : null;
  res.json({ matched: rep.matched, total: rep.total, matchRatio });
});

// ---------------------------------------------------------------------
// Web Push — lets a worker receive a system notification for a matching
// question even when the console tab isn't open. Supplements SSE dispatch,
// never replaces it (see push.js for why).
// ---------------------------------------------------------------------

app.get('/push/vapid-public-key', (req, res) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) return res.status(503).json({ error: 'push notifications are not configured on this server' });
  res.json({ publicKey, configured: isPushConfigured() });
});

app.post('/workers/:address/push-subscribe', rateLimited('push', byIp), async (req, res) => {
  const { subscription, categories, token } = req.body || {};
  if (requiresAuth(req.params.address) && verifySessionToken(token) !== req.params.address) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /workers/:address/session' });
  }
  if (!subscription || typeof subscription !== 'object' || !subscription.endpoint) {
    return res.status(400).json({ error: 'a valid PushSubscription object is required' });
  }
  await saveSubscription(req.params.address, subscription, Array.isArray(categories) ? categories : []);
  res.json({ ok: true });
});

app.post('/workers/:address/push-unsubscribe', rateLimited('push', byIp), async (req, res) => {
  const { token } = req.body || {};
  if (requiresAuth(req.params.address) && verifySessionToken(token) !== req.params.address) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /workers/:address/session' });
  }
  await removeSubscription(req.params.address);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Worker session auth — proves control of a Stellar address via a signed
// throwaway challenge transaction before letting a caller act as it. Only
// required for syntactically valid addresses; the plain test-string
// workerId convenience remains open (see workerAuth.js for why that's safe).
// ---------------------------------------------------------------------

app.post('/workers/:address/session/challenge', rateLimited('push', byIp), async (req, res) => {
  try {
    const xdr = await buildChallengeXdr(req.params.address);
    res.json({ xdr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/workers/:address/session', rateLimited('push', byIp), async (req, res) => {
  const { signedXdr } = req.body || {};
  if (!signedXdr) return res.status(400).json({ error: 'signedXdr is required' });
  const session = await verifyChallengeAndIssueSession(req.params.address, signedXdr);
  if (!session) return res.status(401).json({ error: 'challenge verification failed — signature did not match, or the challenge expired' });
  res.json(session);
});

// ---------------------------------------------------------------------
// Worker-facing SSE dispatch channel.
// ---------------------------------------------------------------------

app.get('/app/events', async (req, res) => {
  const workerId = req.query.worker;
  if (!workerId) return res.status(400).json({ error: 'worker query param is required' });

  if (requiresAuth(workerId) && verifySessionToken(req.query.token) !== workerId) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /workers/:address/session' });
  }

  const allowed = await checkConnectionRateLimit(req.ip);
  if (!allowed) {
    return res.status(429).json({ error: 'too many worker connections from this address, try again shortly' });
  }

  // Categories are normalized (trimmed + lowercased) again inside
  // dispatch.js at both registration and match time — this split is
  // trimmed here purely so the 'connected' echo below looks tidy.
  const categories = String(req.query.categories || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  registerWorker(workerId, res, categories);
  res.write(`event: connected\ndata: ${JSON.stringify({ workerId, categories })}\n\n`);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unregisterWorker(workerId);
  });
});

app.post('/app/answer', rateLimited('answer', byIp), (req, res) => {
  const { questionId, workerId, answer, token } = req.body || {};
  if (!questionId || !workerId || typeof answer !== 'string') {
    return res.status(400).json({ error: 'questionId, workerId, and answer are required' });
  }
  if (answer.length > config.maxAnswerLength) {
    return res.status(400).json({ error: `answer must be at most ${config.maxAnswerLength} characters` });
  }
  if (requiresAuth(workerId) && verifySessionToken(token) !== workerId) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /workers/:address/session' });
  }
  const accepted = submitAnswer(questionId, workerId, answer);
  if (!accepted) {
    return res.status(409).json({ ok: false, error: 'question is closed, expired, or already answered by this worker' });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Admin/ops console — everything here is read-only and gated by
// requireAdmin (see adminAuth.js). No rate limit: these calls don't spend
// a network fee or write state the way /sponsor/* and /oracle do, and the
// bearer-token gate is the actual access control.
// ---------------------------------------------------------------------

app.get('/admin/transactions', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json(await listTransactions({ limit, offset }));
});

app.get('/admin/workers', requireAdmin, async (req, res) => {
  res.json({ workers: await listWorkers() });
});

app.get('/admin/payers', requireAdmin, async (req, res) => {
  res.json({ payers: await listPayers() });
});

app.get('/admin/treasury', requireAdmin, async (req, res) => {
  res.json(await getTreasury());
});

app.get('/admin/fees', requireAdmin, async (req, res) => {
  res.json(await getFeeRevenue());
});

app.get('/admin/payouts', requireAdmin, async (req, res) => {
  res.json({ payouts: await listAnchorPayouts() });
});

app.get('/admin/kyc', requireAdmin, async (req, res) => {
  res.json({ customers: await listAnchorKyc() });
});

// ---------------------------------------------------------------------
// Fiat rails — Arbiter is a CLIENT of one configured SEP-24/SEP-12 anchor
// (see anchorClient.js), never a money transmitter itself. The frontend
// drives SEP-10 auth and the SEP-24 interactive deposit/withdraw flow
// directly against the anchor using the config below (that's the only way
// it can work: the anchor's JWT is gated by the account holder's own
// signature, which this backend never has). /anchor/report is this
// backend's only write path — a self-authenticated user telling us what
// their own browser observed, purely so the admin console has something
// to show (see admin.js's listAnchorPayouts/listAnchorKyc for that caveat).
// ---------------------------------------------------------------------

app.get('/anchor/config', async (req, res) => {
  if (!isAnchorConfigured()) {
    return res.status(503).json({ error: 'no fiat anchor is configured on this server (ANCHOR_HOME_DOMAIN unset)' });
  }
  try {
    res.json(await getAnchorConfig());
  } catch (err) {
    req.log.error({ err }, 'failed to resolve anchor stellar.toml');
    res.status(502).json({ error: 'failed to resolve the configured anchor\'s stellar.toml' });
  }
});

app.post('/anchor/report', rateLimited('push', byIp), async (req, res) => {
  const { address, token, kind, status, amount, assetCode, anchorTransactionId, tier } = req.body || {};
  if (verifySessionToken(token) !== address) {
    return res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session or /workers/:address/session' });
  }

  try {
    if (kind === 'kyc') {
      await recordAnchorKyc(address, { status, tier });
    } else {
      if (!anchorTransactionId) return res.status(400).json({ error: 'anchorTransactionId is required for deposit/withdrawal reports' });
      await recordAnchorTransaction(address, { kind, status, amount, assetCode, anchorTransactionId });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

if (faultInjector) mountFaultRoutes(app, faultInjector, requireAdmin);

// Runs the chain-driven recovery sweep on demand (disasterRecovery.js;
// docs/runbooks/disaster-recovery.md). `?dryRun=true` classifies every
// on-chain Pending question without refunding anything.
app.post('/admin/recovery/sweep', requireAdmin, async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  try {
    const report = await runRecoverySweep({
      store,
      deps: await defaultRecoveryDeps(),
      options: { ...config.recovery, dryRun },
    });
    if (!report) return res.status(409).json({ error: 'another recovery sweep is already running' });
    res.json(report);
  } catch (err) {
    req.log.error({ err }, 'recovery sweep failed');
    res.status(502).json({ error: `recovery sweep failed: ${err.message}` });
  }
});

// Serve the built worker UI from the same Express app.
app.use(express.static(path.join(__dirname, '../../app/dist')));

app.listen(config.port, () => {
  logger.info(
    { port: config.port, contractId: config.contractId || null, network: config.networkPassphrase, allowedOrigins: config.allowedOrigins },
    `Arbiter backend listening on :${config.port}`,
  );

  buildInfo.set({ version: process.env.npm_package_version || 'unknown', network: config.networkPassphrase }, 1);
  startHealthProbes({
    store,
    getLatestLedgerSequence,
    getKnownJobIds,
    getJob,
    getOnlineWorkerCount: onlineWorkerCount,
    intervalMs: config.metrics.probeIntervalMs,
    jobScanIntervalMs: config.metrics.jobScanIntervalMs,
  });

  // After a total state loss this is what gets stranded payers refunded:
  // the first sweep runs immediately on boot, against an empty store.
  if (config.recovery.enabled && config.contractId && config.platformSecret) {
    startRecoverySweeper({ store, intervalMs: config.recovery.intervalMs, options: config.recovery });
  } else {
    logger.warn('recovery sweep disabled (RECOVERY_SWEEP_ENABLED=false, or ORACLE_CONTRACT_ID/PLATFORM_SECRET unset)');
  }
});

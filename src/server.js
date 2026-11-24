import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { issueChallengeIdempotent, verifyPayment, startFulfillment, getJobStatus, cancelJob, fulfillmentDrain } from './oracle.js';
import {
  onlineWorkerCount,
  checkConnectionRateLimit,
  registerWorker,
  unregisterWorker,
  submitAnswer,
  getReputation,
} from './dispatch.js';
import { getStats } from './stats.js';
import { getVapidPublicKey, isPushConfigured, saveSubscription, removeSubscription, initPush } from './push.js';
import { getPayerQuestionIds, summarizePayerQuestions, bucketPayerSpend } from './payerIndex.js';
import { requiresAuth, verifySession, mountSessionRoutes, verifySessionToken } from './workerAuth.js';
import {
  buildSponsoredOnboardTx,
  finalizeSponsoredOnboardTx,
  feeBumpSubmitPayment,
  feeBumpStake,
  feeBumpWithdraw,
  feeBumpWithdrawTo,
  feeBumpWithdrawBalance,
} from './sponsor.js';
import { getStashedQuestion, nextQuestionId } from './pendingQuestions.js';
import { getOwedOnChain, getStakeOnChain, getLatestLedgerSequence, isInsufficientBalanceError } from './stellarClient.js';
import { askMetered, getMeteredBalance, depositInstructions } from './metered.js';
import { getLeaderboard } from './leaderboard.js';
import { getWorkerDashboard } from './workerAnalytics.js';
import { getGamificationProfile, getXpLeaderboard, badgeCatalog } from './gamification.js';
import { stroopsToUsdc, resolveTier, MAX_SURGE_MULTIPLIER } from './pricing.js';
import { checkRateLimit } from './rateLimit.js';
import { issueSandboxChallenge, startSandboxFulfillment } from './sandbox.js';
import { requireAdmin } from './adminAuth.js';
import {
  listTransactions,
  listWorkers,
  listPayers,
  getTreasury,
  getFeeRevenue,
  listAnchorPayouts,
  listAnchorKyc,
  listReferralEarnings,
  getReadReplicaStatus,
} from './admin.js';
import { listPaymentReversals } from './paymentReversals.js';
import { getAnchorConfig, isAnchorConfigured } from './anchorClient.js';
import { recordAnchorTransaction, recordAnchorKyc } from './anchorRecords.js';
import { resolveApiKey, extractApiKey, parseBearer } from './apiKeyAuth.js';
import { parseConsensusRule } from './consensus.js';
import { getPrivatePool, addPoolWorkers, removePoolWorkers, PoolValidationError } from './privatePools.js';
import { isBillingConfigured, createCheckoutSession, handleStripeWebhook, rotateApiKey, getCreditBalanceStroops, reserveCredit, settleReservation } from './billing.js';
import { registerWebhook, listWebhooks, deleteWebhook, WebhookError } from './webhooks.js';
import { getDispatchPause, listUpcomingWindows, describePause, addWindow, removeWindow, listWindows, MaintenanceWindowError } from './maintenanceWindows.js';
import { logger, httpLogger } from './logger.js';
import { startTreasuryMonitor } from './alerting.js';
import { getProvenance } from './provenance.js';
import { verifyProvenance, extractContractCall, verifyPayout } from './provenanceVerify.js';
import { getTransactionEnvelope } from './stellarClient.js';
import { enforceSecurityPosture } from './securityPosture.js';
import { store, RedisStore } from './store.js';
import { createReadOnlyGate, deploymentFingerprint, INSTANCE_ID } from './canary.js';
import {
  getOrCreateReferralCode,
  lookupReferralCode,
  redeemReferralCode,
  getReferralSummary,
  listReferrers,
  ReferralError,
  normalizeCode,
} from './referrals.js';
import { recordWorkerIp, noteAnswerTiming, listFlaggedPairs, getWorkerCollusionReport, clearPairFlag } from './collusion.js';
import { getKnownJobIds, getJob } from './jobs.js';
import {
  metricsMiddleware,
  metricsHandler,
  buildInfo,
} from './metrics.js';
import { createFaultInjector, mountFaultRoutes } from './faultInjection.js';
import { securityHeadersMiddleware } from './securityHeaders.js';
import {
  TeamError,
  createTeam,
  listTeamsFor,
  requireTeamRole,
  renameTeam,
  deleteTeam,
  addMembers,
  setMemberRole,
  removeMember,
} from './teams.js';
import { recordWorkerWithdrawal } from './earnings.js';
import {
  AutoWithdrawError,
  getAutoWithdrawSettings,
  setAutoWithdrawSettings,
  deleteAutoWithdrawSettings,
  checkAutoWithdraw,
  submitAutoWithdraw,
  startAutoWithdrawSweep,
} from './autoWithdraw.js';
import {
  TaxReportError,
  parseTaxYear,
  getTaxProfile,
  saveTaxProfile,
  buildTaxSummary,
  listTaxYears,
  taxSummaryToCsv,
} from './taxReport.js';
import { runRecoverySweep, defaultRecoveryDeps, startRecoverySweeper } from './disasterRecovery.js';
import { startHealthProbes } from './healthProbes.js';
import { checkContractVersion } from './contractVersionCheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Refuse to boot a real deployment that left a severe insecure default in
// place, and log loudly about the rest — see securityPosture.js. Local dev
// with every default untouched passes silently.
if (!enforceSecurityPosture(process.env, logger)) {
  console.error('[security-posture] refusing to start: fix the setting(s) named above.');
  await new Promise((resolve) => logger.flush(resolve));
  process.exit(1);
}

// Startup contract-version verification (#465): closes the gap left by
// #163, where compatibleContractWasmHash was computed but never actually
// checked against the deployed contract. A mismatch here means this
// backend's settlement logic (resolve/refund argument shapes, event
// decoding) was written against a different contract build than what's
// actually live — exactly the kind of drift that caused the
// resolve_batch/refund_batch mismatch in #233. Warn loudly rather than
// refuse to boot: unlike securityPosture's findings this depends on a
// live RPC call that can itself be flaky, so a transient RPC failure
// should not take the whole backend down.
const contractVersionResult = await checkContractVersion({
  contractId: config.contractId,
  compatibleContractWasmHash: config.compatibleContractWasmHash,
});
if (!contractVersionResult.ok) {
  logger.error({ contractVersionResult }, `[contract-version] ${contractVersionResult.reason}`);
} else if (!contractVersionResult.skipped) {
  logger.info({ contractVersionResult }, '[contract-version] deployed contract matches the configured compatible version');
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

// Canary instances (INSTANCE_ROLE=canary) serve only read-only paths; every
// other request gets a 503 the traffic splitter routes to the primary. A
// no-op on a primary. Before every route, including /billing/webhook. See
// canary.js and docs/runbooks/canary-deployment.md.
app.use(createReadOnlyGate({ role: config.canary.role, readPaths: config.canary.readPaths }));
if (config.canary.role === 'canary') {
  logger.warn({ readPaths: config.canary.readPaths }, 'INSTANCE_ROLE=canary: serving read-only paths, never signing as the platform key');
}

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

/** Once SIGTERM starts a drain, new questions go elsewhere (the client
 * retries against whichever instance is live) while this one finishes the
 * fulfillments it already owns. */
function refuseWhileDraining(req, res, next) {
  if (!fulfillmentDrain.isDraining()) return next();
  res.set('Retry-After', '1');
  return res.status(503).json({ error: 'this instance is shutting down; retry shortly' });
}

async function storeReachable() {
  const client = store.getClient();
  if (!client) return true; // in-memory store: nothing to reach
  try {
    return (await Promise.race([client.ping(), new Promise((resolve) => setTimeout(() => resolve(null), 1_000))])) === 'PONG';
  } catch {
    return false;
  }
}

app.get('/metrics', metricsHandler({ token: config.metrics.token }));

app.get('/health', async (req, res) => {
  // deploymentFingerprint() (#465/#163) was written for exactly this route
  // but never actually called from it, so canary.js's comparePreflight()
  // cross-instance check had no real data to compare. storeReachable is a
  // best-effort ping: a RedisStore failing it just means the fingerprint
  // reports it honestly, never that /health itself fails.
  let storeReachable = true;
  if (store instanceof RedisStore) {
    try {
      await store.client.ping();
    } catch {
      storeReachable = false;
    }
  }
  const fingerprint = deploymentFingerprint({
    config,
    instanceId: INSTANCE_ID,
    storeKind: store instanceof RedisStore ? 'redis' : 'memory',
    storeReachable,
  });
  res.json({ ok: true, onlineWorkers: await onlineWorkerCount(), contractId: config.contractId, ...fingerprint });
});

// Public, like /health: the dispatch pause in effect (if any) and every
// scheduled maintenance/holiday window still ahead, so clients and workers
// can plan around them. See maintenanceWindows.js.
app.get('/maintenance', async (req, res) => {
  const now = Date.now();
  const [pause, upcoming] = await Promise.all([getDispatchPause(now), listUpcomingWindows(now)]);
  res.json({
    dispatchPaused: Boolean(pause),
    ...(pause ? { reason: pause.reason, resumesAt: new Date(pause.resumesAt).toISOString() } : {}),
    windows: upcoming.map(serializeWindow),
  });
});

function serializeWindow(w) {
  return { ...w, startsAt: new Date(w.startsAt).toISOString(), endsAt: new Date(w.endsAt).toISOString() };
}

/** 503 + Retry-After for a request that would create a question while
 * dispatch is paused. Returns true if it responded. */
async function rejectIfDispatchPaused(res) {
  const pause = await getDispatchPause();
  if (!pause) return false;
  res.set('Retry-After', String(Math.max(1, Math.ceil((pause.resumesAt - Date.now()) / 1000))));
  res.status(503).json({ error: describePause(pause), reason: pause.reason, resumesAt: new Date(pause.resumesAt).toISOString() });
  return true;
}

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

// Gamification XP leaderboard — see gamification.js. Includes non-established
// workers, unlike /leaderboard, since XP is dominated by matched answers.
app.get('/leaderboard/xp', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ leaderboard: await getXpLeaderboard(limit) });
  } catch (err) {
    req.log.error({ err }, 'failed to build xp leaderboard');
    res.status(500).json({ error: 'failed to build xp leaderboard' });
  }
});

app.get('/gamification/badges', (req, res) => {
  res.json({ badges: badgeCatalog() });
});

app.get('/stats', async (req, res) => {
  const stats = await getStats();
  res.json({ onlineWorkers: await onlineWorkerCount(), ...stats });
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
app.post('/oracle/sandbox', refuseWhileDraining, rateLimited('sandbox', byIp), async (req, res) => {
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
app.post('/oracle', refuseWhileDraining, rateLimited('oracle', byIp), async (req, res) => {
  const questionId = req.header('X-Question-Id');
  const paymentTx = req.header('X-Payment-Tx');
  const { question, tier, category, payerAddress, token, consensusMode, tolerance } = req.body || {};
  // Optional worker referral code (#99). Rejected here only if malformed;
  // whether it actually attributes the payer is decided once payment is
  // verified (first payment only, never self-referral — payerReferrals.js).
  let referralCode = null;
  if (req.body?.referralCode !== undefined && req.body.referralCode !== null && req.body.referralCode !== '') {
    referralCode = normalizeCode(req.body.referralCode);
    if (!referralCode) return res.status(400).json({ error: 'body.referralCode is not a valid referral code' });
  }
  // Only checked on the paths that create a question — step 2 of the
  // classic flow reuses the rule already stashed at step 1.
  const consensus = parseConsensusRule({ consensusMode, tolerance });

  // Third payment method: an `Authorization: Bearer ak_live_...` API key
  // (see apiKeyAuth.js/billing.js) — the wallet-free onramp. Checked first
  // since it needs neither payerAddress nor a session token; everything
  // downstream (dispatch, reconcile, settle) is the identical pipeline,
  // funded from the platform's own pooled balance instead of the caller's.
  const apiKeyAccountId = await resolveApiKey(req);

  // Maintenance windows: refuse to CREATE a question while dispatch is
  // paused, before anyone is charged. Step 2 of the classic flow is let
  // through on purpose — that payer has already paid, and startFulfillment
  // refunds it instead of dispatching (see maintenanceWindows.js).
  const createsQuestion = Boolean(apiKeyAccountId || payerAddress || !questionId || !paymentTx);
  if (createsQuestion && (await rejectIfDispatchPaused(res))) return;

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
        consensusRule: consensus.rule,
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
    if ((await verifySession(token)) !== payerAddress) {
      return res.status(401).json({ error: 'a valid session token for this address is required — see POST /payers/:address/session' });
    }
    if (!consensus.ok) return res.status(400).json({ error: consensus.error });
    try {
      const result = await askMetered(payerAddress, question, tier, category, { consensusRule: consensus.rule });
      return res.status(202).json({ ...result, statusUrl: `/oracle/${result.jobId}` });
    } catch (err) {
      // ContractError::InsufficientBalance (see stellarClient.js's CONTRACT_ERROR_CODES
      // and arbiter-contract's repo-root src/lib.rs / docs/versioning.md).
      if (isInsufficientBalanceError(err)) {
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
      const challenge = await issueChallengeIdempotent(question, tier, category, req.header('Idempotency-Key'), consensus.rule, { referralCode });
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

    const { jobId, cancellableUntil } = await startFulfillment(questionId, verdict.pending, verdict.tier, verdict.payerAddress, { referralCode });
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

mountSessionRoutes(app, '/payers', rateLimited('push', byIp));

app.get('/payers/:address/balance', async (req, res) => {
  if (requiresAuth(req.params.address) && (await verifySession(req.query.token)) !== req.params.address) {
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

app.post('/oracle/:jobId/cancel', rateLimited('oracle', byIp), async (req, res) => {
  const apiKeyAccountId = await resolveApiKey(req);
  const sessionToken = req.body?.token ?? req.body?.sessionToken ?? req.query?.token;
  const result = await cancelJob(req.params.jobId, { sessionToken, apiKeyAccountId });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ jobId: req.params.jobId, ...result.job });
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

// Closes #468/#170's unfinished half: actually RUNS the verification chain
// (provenanceVerify.js's verifyProvenance/extractContractCall/verifyPayout)
// instead of just storing a record nobody checks. Re-derives the consensus
// from the committed inputs alone, then — when the question has settled —
// fetches the real on-chain resolve()/refund() transaction and confirms it
// paid exactly who the record says it should. Public and unauthenticated,
// same trust level as GET /oracle/:jobId/provenance: this is what makes a
// record "independently verifiable" by anyone, not just this backend.
app.get('/oracle/:jobId/provenance/verify', async (req, res) => {
  const entry = await getProvenance(req.params.jobId);
  if (!entry) return res.status(404).json({ error: 'no provenance recorded for this jobId (not settled yet, or settled before provenance existed)' });

  const derivation = verifyProvenance(entry);
  let payout = null;
  const txHash = entry.settlement?.payoutTx || entry.settlement?.refundTx || null;
  if (txHash) {
    try {
      const envelope = await getTransactionEnvelope(txHash);
      if (envelope) {
        const call = extractContractCall(envelope);
        payout = { txHash, ...verifyPayout(entry.record, call) };
      } else {
        payout = { txHash, ok: false, checks: [{ name: 'on-chain transaction retrievable', ok: false, detail: 'RPC endpoint no longer has this transaction' }] };
      }
    } catch (err) {
      payout = { txHash, ok: false, checks: [{ name: 'on-chain transaction decodes', ok: false, detail: String(err.message || err) }] };
    }
  }

  return res.json({
    jobId: req.params.jobId,
    hash: entry.hash,
    derivation,
    payout,
    ok: derivation.ok && (payout === null || payout.ok),
  });
});

// A payer's own question history — there's no account system, so this is
// keyed purely by the payer's on-chain address (recorded the moment their
// payment is verified, see oracle.js::verifyPayment). Job records expire
// after JOB_RESULT_TTL_MS same as everything else in jobs.js, so very old
// entries in the index may resolve to nothing — filtered out below rather
// than surfaced as broken rows.
app.get('/payers/:address/questions', async (req, res) => {
  if (requiresAuth(req.params.address) && (await verifySession(req.query.token)) !== req.params.address) {
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

app.post('/payers/:address/questions/:questionId/cancel', rateLimited('oracle', byIp), async (req, res) => {
  const sessionToken = req.body?.token ?? req.body?.sessionToken ?? req.query?.token;
  const result = await cancelJob(req.params.questionId, { sessionToken });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ jobId: req.params.questionId, ...result.job });
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

async function requirePoolOwner(req, res, token) {
  if (!requiresAuth(req.params.address)) {
    res.status(400).json({ error: 'pool owner must be a valid Stellar address' });
    return false;
  }
  if ((await verifySession(token)) !== req.params.address) {
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
  if (!(await requirePoolOwner(req, res, req.query.token))) return;
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
  if (!(await requirePoolOwner(req, res, token))) return;
  await handlePoolWrite(req, res, () => addPoolWorkers(req.params.address, workers));
});
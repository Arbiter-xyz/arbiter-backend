import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { issueChallengeIdempotent, verifyPayment, startFulfillment, getJobStatus } from './oracle.js';
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
import { getPayerQuestionIds, summarizePayerQuestions } from './payerIndex.js';
import { requiresAuth, buildChallengeXdr, verifyChallengeAndIssueSession, verifySessionToken } from './workerAuth.js';
import {
  buildSponsoredOnboardTx,
  finalizeSponsoredOnboardTx,
  feeBumpSubmitPayment,
  feeBumpStake,
  feeBumpWithdraw,
} from './sponsor.js';
import { getStashedQuestion, nextQuestionId } from './pendingQuestions.js';
import { getOwedOnChain, getStakeOnChain } from './stellarClient.js';
import { stroopsToUsdc } from './pricing.js';
import { checkRateLimit } from './rateLimit.js';
import { issueSandboxChallenge, startSandboxFulfillment } from './sandbox.js';
import { logger, httpLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// One structured log line per request (method/path/status/duration/request
// id), and req.log is available in every handler below for attaching
// further context (questionId, workerId, etc.) to that same request's
// trace. Placed before every other middleware so nothing is unlogged.
app.use(httpLogger);

// Wide open ('*') by default for local dev; set ALLOWED_ORIGINS to a
// comma-separated list to lock this down for a real deployment. Wide-open
// CORS combined with unlimited requests is what makes any-origin request
// flooding possible in the first place, so this is paired with the rate
// limiting below, not a substitute for it.
app.use(cors(config.allowedOrigins.includes('*') ? { origin: '*' } : { origin: config.allowedOrigins }));
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

app.get('/health', (req, res) => {
  res.json({ ok: true, onlineWorkers: onlineWorkerCount(), contractId: config.contractId });
});

// Platform-wide, real-settlement-only counters — safe to surface publicly
// (e.g. a landing page trust strip) since sandbox traffic never counts
// toward these (see stats.js).
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

app.post('/oracle', rateLimited('oracle', byIp), async (req, res) => {
  const questionId = req.header('X-Question-Id');
  const paymentTx = req.header('X-Payment-Tx');

  if (!questionId || !paymentTx) {
    const { question, tier, category } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'body.question (string) is required' });
    }
    if (question.length > config.maxQuestionLength) {
      return res.status(400).json({ error: `body.question must be at most ${config.maxQuestionLength} characters` });
    }
    try {
      const challenge = await issueChallengeIdempotent(question, tier, category, req.header('Idempotency-Key'));
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

    const { jobId } = await startFulfillment(questionId, verdict.pending, verdict.tier);
    return res.status(202).json({
      jobId,
      questionId,
      question: verdict.pending.question,
      statusUrl: `/oracle/${jobId}`,
      quorumSize: verdict.tier.quorumSize,
      timeoutMs: verdict.tier.timeoutMs,
    });
  } catch (err) {
    req.log.error({ err, questionId }, 'failed to process payment/fulfillment');
    return res.status(500).json({ error: 'failed to process payment' });
  }
});

app.get('/oracle/:jobId', async (req, res) => {
  const job = await getJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown or expired jobId' });
  const httpStatus = job.status === 'settled' ? 200 : 202;
  return res.status(httpStatus).json({ jobId: req.params.jobId, ...job });
});

// A payer's own question history — there's no account system, so this is
// keyed purely by the payer's on-chain address (recorded the moment their
// payment is verified, see oracle.js::verifyPayment). Job records expire
// after JOB_RESULT_TTL_MS same as everything else in jobs.js, so very old
// entries in the index may resolve to nothing — filtered out below rather
// than surfaced as broken rows.
app.get('/payers/:address/questions', async (req, res) => {
  const ids = await getPayerQuestionIds(req.params.address);
  const jobs = await Promise.all(ids.map((id) => getJobStatus(id)));
  const summary = summarizePayerQuestions(ids, jobs);

  res.json({
    questions: summary.questions,
    totalTracked: summary.totalTracked,
    totalSpendStroops: summary.totalSpendStroops.toString(),
    totalSpend: stroopsToUsdc(summary.totalSpendStroops),
    successRate: summary.successRate,
  });
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
  const { xdr, workerAddress } = req.body || {};
  if (!xdr || !workerAddress) {
    return res.status(400).json({ error: 'xdr and workerAddress are required' });
  }
  try {
    const result = await feeBumpWithdraw(xdr, workerAddress);
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
  const { subscription, categories } = req.body || {};
  if (!subscription || typeof subscription !== 'object' || !subscription.endpoint) {
    return res.status(400).json({ error: 'a valid PushSubscription object is required' });
  }
  await saveSubscription(req.params.address, subscription, Array.isArray(categories) ? categories : []);
  res.json({ ok: true });
});

app.post('/workers/:address/push-unsubscribe', rateLimited('push', byIp), async (req, res) => {
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

// Serve the built worker UI from the same Express app.
app.use(express.static(path.join(__dirname, '../../app/dist')));

app.listen(config.port, () => {
  logger.info(
    { port: config.port, contractId: config.contractId || null, network: config.networkPassphrase, allowedOrigins: config.allowedOrigins },
    `Arbiter backend listening on :${config.port}`,
  );
});

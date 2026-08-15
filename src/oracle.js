import { nextQuestionId, stashQuestion, getStashedQuestion, dropStashedQuestion } from './pendingQuestions.js';
import { createJob, updateJob, getJob, claimJob } from './jobs.js';
import { dispatchAndCollect, recordOutcome, getSmoothedOnlineWorkerCount } from './dispatch.js';
import { reconcile, draftAnswer } from './reconcile.js';
import { resolveQuestion, refundQuestion, getQuestionOnChain } from './stellarClient.js';
import { resolveTier, listTiersForClient, stroopsToUsdc, priceForTier } from './pricing.js';
import { incrementStat } from './stats.js';
import { recordPayerQuestion } from './payerIndex.js';
import { jobLogger } from './logger.js';
import { store } from './store.js';
import { config } from './config.js';

const IDEMPOTENCY_PREFIX = 'idempotency:';

export async function issueChallenge(questionText, tierKey, category) {
  const questionId = (await nextQuestionId()).toString();
  // Price is snapshotted NOW, at quote time, from a SMOOTHED (trailing-
  // average) worker-supply signal rather than the instantaneous online
  // count — connecting/disconnecting an SSE stream is free and instant, so
  // pricing off the raw count would reward a worker cartel that briefly
  // disconnects right before a question is asked (spiking the surge
  // multiplier) and reconnects in time to answer and split the inflated
  // pool. The smoothed signal is also snapshotted here, not recomputed at
  // payment-verification time, so a payer's price can never move out from
  // under them between quote and payment.
  const priced = priceForTier(tierKey, getSmoothedOnlineWorkerCount());

  await stashQuestion(questionId, {
    question: questionText,
    tierKey: priced.key,
    priceStroops: priced.priceStroops.toString(),
    quorumSize: priced.quorumSize,
    timeoutMs: priced.timeoutMs,
    category: category || null,
    createdAt: Date.now(),
  });

  return {
    questionId,
    amount: stroopsToUsdc(priced.priceStroops),
    amountStroops: priced.priceStroops.toString(),
    surgeMultiplier: priced.surgeMultiplier,
    asset: { code: config.usdc.code, issuer: config.usdc.issuer, sacId: config.usdc.sacId },
    contractId: config.contractId,
    network: config.networkPassphrase,
    tier: priced.key,
    tiers: listTiersForClient(),
    quorumSize: priced.quorumSize,
    timeoutMs: priced.timeoutMs,
    autoRefundAfterLedgers: config.timeoutLedgers,
    instructions:
      `Call submit(payer, ${questionId}, ${priced.priceStroops.toString()}) on contract ${config.contractId}, ` +
      'then retry POST /oracle with X-Payment-Tx and X-Question-Id headers. This call returns 202 immediately ' +
      `once payment is confirmed — poll GET /oracle/${questionId} for the result. If nobody settles this ` +
      `question within ${config.timeoutLedgers} ledgers of your payment landing, anyone (including you) may call ` +
      `refund_timeout(${questionId}) on the contract directly to reclaim your funds without this backend's help.`,
  };
}

/**
 * Wraps issueChallenge() with client-supplied idempotency-key support
 * (Stripe's convention: an `Idempotency-Key` header on a create-like call).
 * Without this, a client whose request timed out on THEIR end after the
 * server had already minted a questionId and responded would, on retry,
 * mint a SECOND questionId for what was semantically the same ask — no
 * funds are at risk either way (nothing is paid until submit() on-chain),
 * but it's confusing and wasteful. step 2 of the flow doesn't need this:
 * questionId itself is already a natural idempotency key there (see
 * startFulfillment's claimJob() usage).
 */
export async function issueChallengeIdempotent(questionText, tierKey, category, idempotencyKey) {
  if (!idempotencyKey) return issueChallenge(questionText, tierKey, category);

  const cacheKey = IDEMPOTENCY_PREFIX + idempotencyKey;
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const challenge = await issueChallenge(questionText, tierKey, category);
  await store.set(cacheKey, challenge, config.pendingQuestionTtlMs);
  return challenge;
}

export async function verifyPayment(questionId) {
  const pending = await getStashedQuestion(questionId);
  if (!pending) return { ok: false, status: 400, reason: 'unknown or expired questionId' };

  const onChain = await getQuestionOnChain(questionId);
  if (!onChain) return { ok: false, status: 402, reason: 'payment not yet visible on-chain', pending };
  if (onChain.status !== 'pending') {
    return { ok: false, status: 402, reason: `question is ${onChain.status} on-chain, expected pending`, pending };
  }

  // Compare against the price actually quoted (snapshotted in the stash at
  // issueChallenge time), never a freshly recomputed surge price — the
  // whole point of quoting is that it doesn't move under the payer.
  const quotedPriceStroops = BigInt(pending.priceStroops);
  if (onChain.amount < quotedPriceStroops) {
    return { ok: false, status: 402, reason: 'on-chain payment amount is below the quoted price', pending };
  }

  const tier = { ...resolveTier(pending.tierKey), priceStroops: quotedPriceStroops };
  await recordPayerQuestion(onChain.payer, questionId);
  return { ok: true, pending, tier };
}

/**
 * Kicks off dispatch/reconcile/settle in the background and returns
 * immediately with a job id. Replaces v1's design of holding the client's
 * HTTP request open for up to the quorum timeout, which is fragile against
 * proxies, mobile networks, and serverless/edge request timeouts.
 *
 * Idempotent on questionId: if a client retries step 2 of the /oracle flow
 * (network blip, timeout on their end) after the server already started
 * fulfillment, calling this again must NOT re-dispatch the question to
 * workers a second time or race a second resolve()/refund() attempt
 * against the first. questionId is already a unique, client-supplied key
 * at this point (it came from step 1), so it doubles as the natural
 * idempotency key here — no separate header needed for this step. Uses an
 * atomic claim (see jobs.js::claimJob) rather than a plain existence check,
 * since two truly concurrent retries could otherwise both observe "no job
 * yet" and both proceed.
 */
export async function startFulfillment(questionId, pending, tier) {
  const claimed = await claimJob(questionId);
  if (!claimed) return { jobId: questionId };

  await createJob(questionId, {
    question: pending.question,
    tier: tier.key,
    quorumSize: tier.quorumSize,
    timeoutMs: tier.timeoutMs,
    amountStroops: tier.priceStroops.toString(),
    amount: stroopsToUsdc(tier.priceStroops),
  });

  fulfillOracleCall(questionId, pending, tier).catch((err) => {
    // fulfillOracleCall is written to always settle the escrow before
    // returning; this catch is a last-resort net so a bug there can't leave
    // the job record stuck in 'awaiting_workers' forever.
    jobLogger(questionId).error({ err }, 'fulfillment crashed unexpectedly');
    updateJob(questionId, {
      status: 'settled',
      outcome: 'refund_pending_timeout',
      reason: `internal error: ${err.message}`,
      autoRefundAfterLedgers: config.timeoutLedgers,
    }).catch(() => {});
  });

  return { jobId: questionId };
}

export async function getJobStatus(questionId) {
  return getJob(questionId);
}

async function fulfillOracleCall(questionId, pending, tier) {
  if (tier.instant) {
    return fulfillInstant(questionId, pending);
  }

  let submissions = [];
  try {
    submissions = await dispatchAndCollect(questionId, pending.question, {
      quorumSize: tier.quorumSize,
      timeoutMs: tier.timeoutMs,
      category: pending.category,
      preferEstablished: tier.preferEstablished,
    });
  } catch (err) {
    // dispatchAndCollect is designed to never reject, but guard anyway — an
    // empty submissions list still routes through reconcile()'s no-answers
    // path below, which forces a refund. Never let a dispatch failure be
    // the reason a payment goes unsettled.
    jobLogger(questionId).error({ err }, 'dispatch threw unexpectedly');
  }

  await updateJob(questionId, { status: 'reconciling', totalAnswers: submissions.length });

  const result = await reconcile(pending.question, submissions, questionId);

  const shouldResolve =
    submissions.length > 0 && result.matchingWorkerIds.length > 0 && result.confidence >= config.minConfidence;

  if (shouldResolve) {
    await settleResolved(questionId, submissions, result);
  } else {
    await settleRefunded(questionId, submissions, result);
  }
}

/**
 * The `instant` tier's fulfillment: no human dispatch, no quorum wait —
 * generate a draft answer directly and settle immediately. There is no
 * human worker to pay here, so on success the platform address itself is
 * passed as resolve()'s sole "winner": it's the party that actually
 * provided the value (the LLM call), and the contract has no notion of who
 * a worker "is" beyond an address that gets credited — see charge()'s and
 * resolve()'s doc comments. Failure (no API key, Claude error) fails
 * closed exactly like the human path: refund, never charge for nothing.
 */
async function fulfillInstant(questionId, pending) {
  await updateJob(questionId, { status: 'reconciling', totalAnswers: 0 });

  const result = await draftAnswer(pending.question, questionId);

  if (result && result.consensus) {
    await settleInstantResolved(questionId, result);
  } else {
    await settleRefunded(questionId, [], {
      consensus: null,
      confidence: 0,
      matchingWorkerIds: [],
      method: 'llm-draft-unavailable',
      reason: 'instant tier could not produce a draft answer (LLM unavailable or errored)',
    });
  }
}

async function settleInstantResolved(questionId, result) {
  try {
    const { hash } = await resolveQuestion(questionId, [config.platformAddress], []);
    await dropStashedQuestion(questionId);
    await incrementStat('resolved');
    await updateJob(questionId, {
      status: 'settled',
      outcome: 'resolved',
      answer: result.consensus,
      confidence: result.confidence,
      reconciliationMethod: result.method,
      totalAnswers: 0,
      matchingWorkers: [],
      slashedWorkers: [],
      payoutTx: hash,
      payoutModel: 'instant tier — no human worker involved, settled directly to the platform',
    });
  } catch (err) {
    const onChainNow = await getQuestionOnChain(questionId).catch(() => null);
    if (onChainNow && onChainNow.status === 'refunded') {
      jobLogger(questionId).warn('instant tier lost the settlement race to a third-party refund_timeout()');
      await incrementStat('refunded');
      await updateJob(questionId, {
        status: 'settled',
        outcome: 'lost_race_to_timeout_refund',
        reason: "a third party force-refunded via refund_timeout() before this backend's resolve() landed",
        confidence: result.confidence,
        reconciliationMethod: result.method,
        totalAnswers: 0,
      });
      return;
    }

    jobLogger(questionId).error({ err }, 'instant tier resolve() failed, falling back to refund');
    await settleRefunded(questionId, [], { ...result, reason: `on-chain resolve failed: ${err.message}` });
  }
}

async function settleResolved(questionId, submissions, result) {
  try {
    const matchingSet = new Set(result.matchingWorkerIds);
    const losingWorkerIds = submissions.map((s) => s.workerId).filter((id) => !matchingSet.has(id));

    const { hash } = await resolveQuestion(questionId, result.matchingWorkerIds, losingWorkerIds);
    await recordReputationOutcomes(submissions, result.matchingWorkerIds);
    await dropStashedQuestion(questionId);
    await incrementStat('resolved');
    await updateJob(questionId, {
      status: 'settled',
      outcome: 'resolved',
      answer: result.consensus,
      confidence: result.confidence,
      reconciliationMethod: result.method,
      totalAnswers: submissions.length,
      matchingWorkers: result.matchingWorkerIds,
      slashedWorkers: losingWorkerIds,
      payoutTx: hash,
      payoutModel: 'accrued-balance — matching workers were credited on-chain and withdraw() at their own discretion',
    });
  } catch (err) {
    // Don't guess at *why* resolve() failed by string-matching an opaque
    // XDR error — check the definitive source of truth instead. If the
    // question is already 'refunded' on-chain, a third party (most
    // plausibly the payer) won the race against us via the permissionless
    // refund_timeout() escape hatch. That's an inherent tension of that
    // fail-safe (see the round-2 pressure-test writeup), not a bug — tag it
    // distinctly instead of burying it in generic "resolve failed" logs, so
    // operators can see how often it actually happens in practice.
    const onChainNow = await getQuestionOnChain(questionId).catch(() => null);
    if (onChainNow && onChainNow.status === 'refunded') {
      jobLogger(questionId).warn('lost the settlement race to a third-party refund_timeout()');
      await recordReputationOutcomes(submissions, []);
      await incrementStat('refunded');
      await updateJob(questionId, {
        status: 'settled',
        outcome: 'lost_race_to_timeout_refund',
        reason: "a third party (possibly the payer) force-refunded via refund_timeout() before this backend's resolve() landed",
        confidence: result.confidence,
        reconciliationMethod: result.method,
        totalAnswers: submissions.length,
      });
      return;
    }

    // Reconciliation succeeded but the on-chain resolve() call failed for
    // some other reason (e.g. RPC hiccup). Fail closed: fall back to
    // attempting a refund rather than leaving the job — and the payer's
    // money — stuck mid-flight.
    jobLogger(questionId).error({ err }, 'resolve() failed, falling back to refund');
    await settleRefunded(questionId, submissions, { ...result, reason: `on-chain resolve failed: ${err.message}` });
  }
}

async function settleRefunded(questionId, submissions, result) {
  const hash = await refundQuestion(questionId)
    .then((r) => r.hash)
    .catch((err) => {
      // Even the admin refund() call failed. This is exactly what the
      // contract's permissionless refund_timeout() escape hatch exists
      // for: once TIMEOUT_LEDGERS pass, anyone — including the payer's own
      // client — can force the refund without this backend's cooperation.
      jobLogger(questionId).error(
        { err },
        "refund() ALSO failed — payer can fall back to refund_timeout()",
      );
      return null;
    });

  await recordReputationOutcomes(submissions, result.matchingWorkerIds || []);
  if (hash) {
    await dropStashedQuestion(questionId);
    await incrementStat('refunded');
  }

  await updateJob(questionId, {
    status: 'settled',
    outcome: hash ? 'refunded' : 'refund_pending_timeout',
    reason: result.reason || describeRefundReason(result),
    confidence: result.confidence,
    reconciliationMethod: result.method,
    totalAnswers: submissions.length,
    refundTx: hash,
    ...(hash ? {} : { autoRefundAfterLedgers: config.timeoutLedgers }),
  });
}

function describeRefundReason(result) {
  if (result.method === 'no-answers') return 'no workers answered in time';
  return `confidence ${result.confidence.toFixed(2)} below MIN_CONFIDENCE threshold`;
}

async function recordReputationOutcomes(submissions, matchingWorkerIds) {
  const matchingSet = new Set(matchingWorkerIds);
  await Promise.all(submissions.map((s) => recordOutcome(s.workerId, matchingSet.has(s.workerId))));
}

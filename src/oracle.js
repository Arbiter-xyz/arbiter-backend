import { nextQuestionId, stashQuestion, getStashedQuestion, dropStashedQuestion } from './pendingQuestions.js';
import { createJob, updateJob, getJob, claimJob } from './jobs.js';
import { dispatchAndCollect, recordOutcome, getReputation, getSmoothedOnlineWorkerCount, hasOnlineWhitelistedWorker } from './dispatch.js';
import { assessQuorum, recordQuorumObservation } from './collusion.js';
import { reconcile, draftAnswer } from './reconcile.js';
import { resolveQuestion, refundQuestion, getQuestionOnChain } from './stellarClient.js';
import { resolveTier, listTiersForClient, stroopsToUsdc, priceForTier, effectiveEscalatedPriceStroops } from './pricing.js';
import { incrementStat } from './stats.js';
import { recordPayerQuestion } from './payerIndex.js';
import { getPrivatePool } from './privatePools.js';
import { notifyWorker } from './push.js';
import { enqueueSettlementWebhooks } from './webhookDelivery.js';
import { setJobWebhookOwner } from './webhooks.js';
import { jobLogger } from './logger.js';
import { store } from './store.js';
import { buildProvenanceRecord, saveProvenance, attachSettlement } from './provenance.js';
import { config } from './config.js';
import { undoWindowFor, holdThenDispatch, cancelHeld } from './undoWindow.js';
import { verifySessionToken } from './workerAuth.js';
import { restoreCredit } from './billing.js';

const IDEMPOTENCY_PREFIX = 'idempotency:';
// Who may cancel an API-key-funded job. Kept out of the job record itself,
// which GET /oracle/:jobId returns verbatim to anyone holding the jobId.
const JOB_OWNER_PREFIX = 'job-owner:';

/**
 * `consensusRule` is a validated rule from consensus.js's
 * parseConsensusRule(), or null for the default exact-match mode. Only a
 * non-default rule adds fields to the stash and the response, so the
 * default path's records are unchanged.
 */
export function consensusStashFields(consensusRule) {
  if (!consensusRule) return {};
  return { consensusMode: consensusRule.mode, consensusTolerance: consensusRule.tolerance };
}

/** Rebuilds the rule reconcile() takes from a stashed pending question. */
export function consensusRuleFromPending(pending) {
  if (!pending?.consensusMode || pending.consensusMode === DEFAULT_CONSENSUS_MODE) return null;
  return { mode: pending.consensusMode, tolerance: pending.consensusTolerance };
}

export async function issueChallenge(questionText, tierKey, category, consensusRule = null) {
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
    ...consensusStashFields(consensusRule),
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
    ...consensusStashFields(consensusRule),
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
export async function issueChallengeIdempotent(questionText, tierKey, category, idempotencyKey, consensusRule = null) {
  if (!idempotencyKey) return issueChallenge(questionText, tierKey, category, consensusRule);

  const cacheKey = IDEMPOTENCY_PREFIX + idempotencyKey;
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const challenge = await issueChallenge(questionText, tierKey, category, consensusRule);
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
  return { ok: true, pending, tier, payerAddress: onChain.payer };
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
 *
 * `payerAddress` is optional (the sandbox path has no real payer) and, when
 * present, is both stored on the job record (so the admin console's
 * Transactions view can show who asked) and indexed via
 * recordPayerQuestion — centralized here, the one place both the classic
 * submit()-based flow (verifyPayment) and the prepaid-balance flow
 * (askMetered) converge, instead of duplicated in each caller.
 *
 * Non-instant tiers are first held for the undo window (see undoWindow.js)
 * in status 'holding'; dispatch only starts once the hold elapses without
 * a cancelJob() claiming the job first. `apiKeyAccountId` marks a job
 * funded through the API-key path, whose `payerAddress` is the platform's
 * pooled fiat address — it's what cancelJob() authenticates against there.
 */
export async function startFulfillment(questionId, pending, tier, payerAddress, { ownerAccountId } = {}) {
  const claimed = await claimJob(questionId);
  if (!claimed) return { jobId: questionId };

  const holdMs = undoWindowFor(tier);
  const cancellableUntil = holdMs > 0 ? Date.now() + holdMs : null;

  await createJob(questionId, {
    ...(cancellableUntil ? { status: 'holding', cancellableUntil } : {}),
    question: pending.question,
    tier: tier.key,
    quorumSize: tier.quorumSize,
    timeoutMs: tier.timeoutMs,
    amountStroops: tier.priceStroops.toString(),
    amount: stroopsToUsdc(tier.priceStroops),
    payer: payerAddress || null,
    // Persisted past dispatch time (it already routes dispatch in
    // fulfillOracleCall) so per-category spend is visible to every reader
    // of the job record: GET /oracle/:jobId, GET /payers/:address/questions
    // and GET /admin/transactions all spread the full record.
    category: pending.category || null,
  });

  if (apiKeyAccountId) {
    await store.set(JOB_OWNER_PREFIX + questionId, { apiKeyAccountId }, config.jobResultTtlMs);
  }
  if (payerAddress) await recordPayerQuestion(payerAddress, questionId);
  // API-key customers are charged from the shared fiat pool, so `payer`
  // can't identify them; record who to send settlement webhooks to instead.
  if (ownerAccountId) await setJobWebhookOwner(questionId, `account:${ownerAccountId}`);

  if (!cancellableUntil) {
    runFulfillment(questionId, pending, tier);
    return { jobId: questionId };
  }

  holdThenDispatch(
    questionId,
    holdMs,
    async () => {
      await updateJob(questionId, { status: 'awaiting_workers', cancellableUntil: null, dispatchedAt: Date.now() });
      runFulfillment(questionId, pending, tier);
    },
    (err) => jobLogger(questionId).error({ err }, 'failed to start dispatch after the undo window'),
  );

  return { jobId: questionId, cancellableUntil };
}

function runFulfillment(questionId, pending, tier) {
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
    })
      .then((job) => announceSettlement(questionId, job))
      .catch(() => {});
  });
}

/**
 * Cancels a paid question inside its undo window and refunds it through
 * settleRefunded() — the exact refund()/refund_pending_timeout path every
 * other refund takes, not a parallel one.
 *
 * Who may cancel: whoever paid, proven the same way every other
 * payer-scoped route proves it.
 *  - Classic submit() flow and the prepaid/metered flow: a session token
 *    for the job's `payer` address (POST /payers/:address/session). For the
 *    classic flow the payer is only known once verifyPayment() reads it off
 *    the on-chain Question, so this is the one proof that works for both —
 *    the canceller signs the same throwaway challenge workerAuth.js uses.
 *  - API-key flow: the same API key that asked. Its on-chain payer is the
 *    platform's pooled fiat address, so a session token can't identify the
 *    customer there; the refund returns to the pool and the customer's
 *    credit is restored here. That credit is restored even if refund()
 *    itself fails, because a cancelled job is never dispatched and so can
 *    never be resolve()d — its escrow can only ever go back to the pool,
 *    via refund() now or refund_timeout() later.
 *
 * Returns `{ ok: true, job }` or `{ ok: false, status, error }`. Never
 * races dispatch: undoWindow.js's atomic decision claim guarantees exactly
 * one of "cancel" or "dispatch" wins, so a cancel that loses gets a 409
 * instead of refunding a question workers are already answering.
 */
export async function cancelJob(jobId, { sessionToken, apiKeyAccountId } = {}) {
  const job = await getJob(jobId);
  if (!job || job.sandbox) return { ok: false, status: 404, error: 'unknown or expired jobId' };

  const owner = await store.get(JOB_OWNER_PREFIX + jobId);
  const authorized = owner?.apiKeyAccountId
    ? Boolean(apiKeyAccountId) && apiKeyAccountId === owner.apiKeyAccountId
    : Boolean(job.payer) && verifySessionToken(sessionToken) === job.payer;
  if (!authorized) {
    return {
      ok: false,
      status: 401,
      error: owner?.apiKeyAccountId
        ? 'the API key that asked this question is required to cancel it'
        : "a valid session token for this job's payer is required — see POST /payers/:address/session",
    };
  }

  if (job.tier === 'instant') {
    return { ok: false, status: 409, error: 'instant-tier questions have no undo window' };
  }
  if (job.status !== 'holding') {
    return { ok: false, status: 409, error: notCancellableReason(job.status) };
  }

  const { cancelled } = await cancelHeld(jobId, async () => {
    await updateJob(jobId, { status: 'cancelling', cancellableUntil: null, cancelledAt: Date.now() });
    await settleRefunded(
      jobId,
      [],
      {
        consensus: null,
        confidence: 0,
        matchingWorkerIds: [],
        method: 'cancelled-by-payer',
        reason: 'cancelled by the payer during the undo window',
      },
      { cancelledByPayer: true },
    );
    if (owner?.apiKeyAccountId) await restoreCredit(owner.apiKeyAccountId, Number(job.amountStroops));
  });

  if (!cancelled) return { ok: false, status: 409, error: notCancellableReason('awaiting_workers') };
  return { ok: true, job: await getJob(jobId) };
}

function notCancellableReason(status) {
  if (status === 'settled') return 'this question has already settled';
  if (status === 'cancelling') return 'this question is already being cancelled';
  return 'already dispatched to workers — the undo window has closed';
}

export async function getJobStatus(questionId) {
  return getJob(questionId);
}

/**
 * Whether a human-quorum question should get an LLM draft sent to workers
 * as a prefill suggestion. Pure (settings are a parameter, defaulting to
 * config) so every combination is testable despite config being frozen at
 * load — same reason stakeGateAllows() exists as its own function. Never
 * for `instant`, which already drafts and settles on its own.
 */
export function shouldDraftSuggestion(tier, settings = { ...config.draftSuggestions, apiKey: config.anthropicApiKey }) {
  if (!tier || tier.instant) return false;
  if (!settings.enabled || !settings.apiKey) return false;
  return settings.tiers.includes(tier.key);
}

async function fulfillOracleCall(questionId, pending, tier) {
  if (tier.instant) {
    return fulfillInstant(questionId, pending, tier);
  }

  // Started concurrently with dispatch, never awaited here — the suggestion
  // is additive, so it can't be allowed to delay or fail the broadcast (see
  // dispatchAndCollect's `suggestion` option for the delivery side).
  // draftAnswer() never throws and resolves null on any failure.
  const suggestion = shouldDraftSuggestion(tier)
    ? draftAnswer(pending.question, questionId, { purpose: 'worker-suggestion' })
    : undefined;

  let submissions = [];
  // Only set for escalating tiers; see dispatchEscalating's return shape.
  let escalated = null;
  try {
    submissions = await dispatchAndCollect(questionId, pending.question, {
      quorumSize: tier.quorumSize,
      timeoutMs: tier.timeoutMs,
      category: pending.category,
      preferEstablished: tier.preferEstablished,
      suggestion,
    });
  } catch (err) {
    // dispatchAndCollect is designed to never reject, but guard anyway — an
    // empty submissions list still routes through reconcile()'s no-answers
    // path below, which forces a refund. Never let a dispatch failure be
    // the reason a payment goes unsettled.
    jobLogger(questionId).error({ err }, 'dispatch threw unexpectedly');
  }

  await updateJob(questionId, { status: 'reconciling', totalAnswers: submissions.length });

  // A flagged pair (collusion.js) that gave the same answer in this quorum
  // loses the reconcile fast path: their shared track record is exactly
  // what's in doubt, so it can't be what vouches for this consensus. They
  // are treated as unestablished for this one quorum, which also keeps the
  // provenance record's `established` flags consistent with the path taken.
  const collusionCheck = await assessQuorum(submissions);
  if (collusionCheck.suspicious) {
    const flagged = new Set(collusionCheck.workerIds);
    submissions = submissions.map((s) => (flagged.has(s.workerId) ? { ...s, established: false } : s));
    jobLogger(questionId).warn({ pairs: collusionCheck.pairs }, 'quorum contains a flagged collusion pair — forcing review');
    await updateJob(questionId, { collusionReview: { pairs: collusionCheck.pairs.map((p) => ({ pair: p.pair, score: p.score })) } });
  }

  const result = await reconcile(pending.question, submissions, questionId, consensusRuleFromPending(pending));

  // A lone answer has no peers to be reconciled against, so reconcile()'s
  // "unanimous + established" fast path reports confidence 1 for it. Settling
  // on one worker must not get to skip the confidence bar by construction:
  // cap it at the confidence dispatch actually had in that worker, so the
  // shouldResolve / MIN_CONFIDENCE gate below judges the real number, exactly
  // as it does for every other path.
  if (escalated && submissions.length === 1 && escalated.confidence !== null) {
    result.confidence = Math.min(result.confidence, escalated.confidence);
  }

  const shouldResolve =
    submissions.length > 0 && result.matchingWorkerIds.length > 0 && result.confidence >= config.minConfidence;

  await commitProvenance(questionId, pending, tier, submissions, result, shouldResolve ? 'resolve' : 'refund');

  if (shouldResolve) {
    await settleResolved(questionId, submissions, result);
  } else {
    await settleRefunded(questionId, submissions, result);
  }
  await recordSettlementProvenance(questionId);
}

/**
 * Commits to every raw reconciliation input (see provenance.js) BEFORE
 * resolve()/refund() is sent, and publishes the hash on the job record.
 * Never throws: provenance is an audit trail, so a failure to write it must
 * never be the reason a payer's escrow goes unsettled.
 */
async function commitProvenance(questionId, pending, tier, submissions, result, action) {
  try {
    const record = buildProvenanceRecord({
      questionId,
      question: pending.question,
      tier: tier.key,
      submissions,
      result,
      minConfidence: config.minConfidence,
      action,
    });
    const provenanceHash = await saveProvenance(questionId, record);
    await updateJob(questionId, { provenanceHash });
  } catch (err) {
    jobLogger(questionId).error({ err }, 'failed to commit reconciliation provenance');
  }
}

/** Copies the settlement outcome and tx hashes (known only after settling)
 * next to the committed record, outside the hash. Never throws. */
async function recordSettlementProvenance(questionId) {
  try {
    const job = await getJob(questionId);
    if (!job) return;
    await attachSettlement(questionId, {
      outcome: job.outcome || null,
      payoutTx: job.payoutTx || null,
      refundTx: job.refundTx || null,
    });
  } catch (err) {
    jobLogger(questionId).error({ err }, 'failed to record settlement provenance');
  }
}

/**
 * Persists what an escalating question really cost — recruited-worker count,
 * final quorum target, and the effective price against the ceiling that was
 * charged — on the job record (surfaced by GET /oracle/:jobId and the admin
 * console), then lets the caller refund the difference if its billing flow
 * can (see startFulfillment). `amountStroops` stays the amount actually
 * charged; `effectiveAmountStroops` is what the recruited quorum was worth.
 */
async function recordEscalationCost(questionId, tier, escalated, hooks) {
  const effective = effectiveEscalatedPriceStroops(tier, escalated.recruitedWorkers);
  await updateJob(questionId, {
    recruitedWorkers: escalated.recruitedWorkers,
    quorumSizeUsed: escalated.finalQuorumSize,
    dispatchSettledBy: escalated.settledBy,
    effectiveAmountStroops: effective.toString(),
    effectiveAmount: stroopsToUsdc(effective),
  });
  if (hooks.onEffectiveCost) {
    try {
      await hooks.onEffectiveCost(effective);
    } catch (err) {
      jobLogger(questionId).error({ err }, 'onEffectiveCost hook failed');
    }
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
async function fulfillInstant(questionId, pending, tier) {
  await updateJob(questionId, { status: 'reconciling', totalAnswers: 0 });

  const draft = await draftAnswer(pending.question, questionId);
  const resolved = Boolean(draft && draft.consensus);
  const result = resolved
    ? draft
    : {
        consensus: null,
        confidence: 0,
        matchingWorkerIds: [],
        method: 'llm-draft-unavailable',
        reason: 'instant tier could not produce a draft answer (LLM unavailable or errored)',
      };

  await commitProvenance(questionId, pending, tier, [], result, resolved ? 'resolve' : 'refund');

  if (resolved) {
    await settleInstantResolved(questionId, result);
  } else {
    await settleRefunded(questionId, [], result);
  }
  await recordSettlementProvenance(questionId);
}

async function settleInstantResolved(questionId, result) {
  try {
    const { hash } = await resolveQuestion(questionId, [config.platformAddress], []);
    await dropStashedQuestion(questionId);
    await incrementStat('resolved');
    const job = await updateJob(questionId, {
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
    announceSettlement(questionId, job);
  } catch (err) {
    const onChainNow = await getQuestionOnChain(questionId).catch(() => null);
    if (onChainNow && onChainNow.status === 'refunded') {
      jobLogger(questionId).warn('instant tier lost the settlement race to a third-party refund_timeout()');
      await incrementStat('refunded');
      const job = await updateJob(questionId, {
        status: 'settled',
        outcome: 'lost_race_to_timeout_refund',
        reason: "a third party force-refunded via refund_timeout() before this backend's resolve() landed",
        confidence: result.confidence,
        reconciliationMethod: result.method,
        totalAnswers: 0,
      });
      announceSettlement(questionId, job);
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
    await recordReputationOutcomes(questionId, submissions, result.matchingWorkerIds);
    await dropStashedQuestion(questionId);
    await incrementStat('resolved');

    // Proactive "you got paid" push — a worker who answers once and closes
    // the tab has no other way to learn they were credited (the console
    // only shows it on the next visit/poll). notifyWorker() never throws,
    // so a failed notification can never put settlement itself at risk.
    for (const workerId of result.matchingWorkerIds) {
      notifyWorker(workerId, {
        title: 'You got paid on Arbiter',
        body: 'Your answer matched consensus — the payout is credited and ready to withdraw.',
        questionId: questionId.toString(),
        type: 'credited',
      }).catch(() => {});
    }
    const job = await updateJob(questionId, {
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
    announceSettlement(questionId, job);
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
      await recordReputationOutcomes(questionId, submissions, []);
      await incrementStat('refunded');
      const job = await updateJob(questionId, {
        status: 'settled',
        outcome: 'lost_race_to_timeout_refund',
        reason: "a third party (possibly the payer) force-refunded via refund_timeout() before this backend's resolve() landed",
        confidence: result.confidence,
        reconciliationMethod: result.method,
        totalAnswers: submissions.length,
      });
      announceSettlement(questionId, job);
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

async function settleRefunded(questionId, submissions, result, extraJobFields = {}) {
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

  await recordReputationOutcomes(questionId, submissions, result.matchingWorkerIds || []);
  if (hash) {
    await dropStashedQuestion(questionId);
    await incrementStat('refunded');
  }

  const job = await updateJob(questionId, {
    status: 'settled',
    outcome: hash ? 'refunded' : 'refund_pending_timeout',
    reason: result.reason || describeRefundReason(result),
    confidence: result.confidence,
    reconciliationMethod: result.method,
    totalAnswers: submissions.length,
    refundTx: hash,
    ...(hash ? {} : { autoRefundAfterLedgers: config.timeoutLedgers }),
    ...extraJobFields,
  });
  announceSettlement(questionId, job);
}

/**
 * Settlement webhooks (webhookDelivery.js) are their own concern, separate
 * from the worker push notifications above: the payer or API-key customer
 * who asked is told the question settled. Called after the job record
 * reaches its final `settled` state. enqueueSettlementWebhooks() returns
 * immediately and never throws, so a slow or dead receiver can't delay or
 * fail settlement.
 */
function announceSettlement(questionId, job) {
  try {
    enqueueSettlementWebhooks(questionId, job);
  } catch (err) {
    jobLogger(questionId).error({ err }, 'failed to enqueue settlement webhooks');
  }
}

function describeRefundReason(result) {
  if (result.method === 'no-answers') return 'no workers answered in time';
  return `confidence ${result.confidence.toFixed(2)} below MIN_CONFIDENCE threshold`;
}

async function recordReputationOutcomes(questionId, submissions, matchingWorkerIds) {
  const matchingSet = new Set(matchingWorkerIds);
  await Promise.all(submissions.map((s) => recordOutcome(s.workerId, matchingSet.has(s.workerId))));
  // After reputation, so the pair scoring's agreement baseline includes
  // this question. Never throws (see collusion.js).
  await recordQuorumObservation(questionId, submissions, matchingWorkerIds, { getReputation });
}

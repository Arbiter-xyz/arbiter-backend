import { createJob, updateJob } from './jobs.js';
import { resolveTier } from './pricing.js';
import { exactMatchVote } from './reconcile.js';
import { config } from './config.js';
import { jobLogger } from './logger.js';

/**
 * Sandbox mode: ask a question with zero real payment and get a realistic,
 * fully-typed job response back — no wallet, no testnet USDC, no chain
 * dependency at all. This exists because the single biggest drop-off point
 * for a prospective integrator isn't the API design, it's everything
 * *before* they can even see what a response looks like: get a Stellar
 * wallet, find a testnet USDC faucet, understand submit()/signing, THEN
 * finally see one example response. Sandbox mode collapses that to one
 * HTTP call, so someone can decide whether to trust the real thing before
 * they've spent any setup effort at all.
 *
 * Deliberately never touches stellarClient.js/Claude:
 *  - No chain calls, so it works even with no deployed contract configured
 *    (true in this dev environment) and never costs the platform a network fee.
 *  - No Claude calls, so it's free, fast, and fully deterministic — every
 *    outcome path is driven by exactMatchVote(), the same grouping logic
 *    production reconciliation falls back to, just never escalated to an
 *    LLM here. That keeps sandbox mode from being a free way to spend the
 *    platform's Anthropic budget.
 * Every response is unambiguously tagged `sandbox: true` and fake tx
 * hashes are prefixed "SANDBOX-" so nothing here can be mistaken for a
 * real settlement.
 */

const SIMULATE_MODES = new Set(['resolved', 'disagreement', 'no-answers']);

function deriveSandboxAnswer(question) {
  const trimmed = question.trim().slice(0, 80);
  return `[sandbox] This is a simulated consensus answer for: "${trimmed}"`;
}

function cannedSubmissions(question, simulate) {
  if (simulate === 'no-answers') return [];

  const answer = deriveSandboxAnswer(question);
  if (simulate === 'disagreement') {
    return [
      { workerId: 'sandbox-worker-1', answer },
      { workerId: 'sandbox-worker-2', answer: '[sandbox] I think it might be something different' },
      { workerId: 'sandbox-worker-3', answer: '[sandbox] Not confident, possibly unrelated answer' },
    ];
  }
  // 'resolved' (default): near-unanimous, trivial whitespace variation on
  // one submission so exactMatchVote's normalization is genuinely exercised.
  return [
    { workerId: 'sandbox-worker-1', answer },
    { workerId: 'sandbox-worker-2', answer: `${answer}  ` },
    { workerId: 'sandbox-worker-3', answer },
  ];
}

function fakeTxHash(kind) {
  return `SANDBOX-${kind}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function issueSandboxChallenge(questionId, questionText, tierKey) {
  const tier = resolveTier(tierKey);
  return {
    sandbox: true,
    questionId,
    question: questionText,
    tier: tier.key,
    quorumSize: tier.quorumSize,
    timeoutMs: tier.timeoutMs,
    amount: '0.00',
    amountStroops: '0',
    note: 'Sandbox mode: no payment required, no real chain or LLM calls made. Every field ' +
      'below matches the shape of a real response so you can build against it directly.',
  };
}

/**
 * Mirrors oracle.js's startFulfillment()/fulfillOracleCall() shape closely
 * enough that a client polling GET /oracle/:jobId can't tell the
 * difference structurally — only the `sandbox: true` flag and the
 * SANDBOX-prefixed tx hashes give it away.
 */
export async function startSandboxFulfillment(questionId, questionText, { tierKey, simulate } = {}) {
  const tier = resolveTier(tierKey);
  const mode = SIMULATE_MODES.has(simulate) ? simulate : 'resolved';

  await createJob(questionId, {
    sandbox: true,
    question: questionText,
    tier: tier.key,
    quorumSize: tier.quorumSize,
    timeoutMs: tier.timeoutMs,
  });

  runSandboxFulfillment(questionId, questionText, mode).catch((err) => {
    jobLogger(questionId).error({ err, sandbox: true }, 'sandbox job crashed unexpectedly');
    updateJob(questionId, {
      status: 'settled',
      outcome: 'refunded',
      reason: `sandbox internal error: ${err.message}`,
      refundTx: fakeTxHash('refund'),
    }).catch(() => {});
  });

  return { jobId: questionId };
}

async function runSandboxFulfillment(questionId, questionText, mode) {
  // A short, fixed synthetic delay — enough that a client's poll loop
  // genuinely observes an awaiting_workers -> reconciling -> settled
  // progression (exercising real integration code paths), never so long
  // that trying the product feels slow.
  await sleep(350);

  const submissions = cannedSubmissions(questionText, mode);
  await updateJob(questionId, { status: 'reconciling', totalAnswers: submissions.length });
  await sleep(350);

  const result =
    submissions.length === 0
      ? { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' }
      : (() => {
          const vote = exactMatchVote(submissions);
          return {
            consensus: vote.consensus,
            confidence: vote.allAgree ? 1 : vote.confidence,
            matchingWorkerIds: vote.matchingWorkerIds,
            method: vote.allAgree ? 'exact-match-fastpath' : 'exact-match-fallback',
          };
        })();

  // Same settlement threshold real oracle.js uses, so sandbox behavior
  // stays honest about what would actually happen with these submissions.
  const shouldResolve =
    submissions.length > 0 && result.matchingWorkerIds.length > 0 && result.confidence >= config.minConfidence;

  if (shouldResolve) {
    await updateJob(questionId, {
      status: 'settled',
      outcome: 'resolved',
      answer: result.consensus,
      confidence: result.confidence,
      reconciliationMethod: result.method,
      totalAnswers: submissions.length,
      matchingWorkers: result.matchingWorkerIds,
      payoutTx: fakeTxHash('payout'),
      payoutModel: 'sandbox — no real funds moved',
    });
  } else {
    await updateJob(questionId, {
      status: 'settled',
      outcome: 'refunded',
      reason:
        result.method === 'no-answers'
          ? 'no workers answered in time (simulated)'
          : `confidence ${result.confidence.toFixed(2)} below MIN_CONFIDENCE threshold (simulated)`,
      confidence: result.confidence,
      reconciliationMethod: result.method,
      totalAnswers: submissions.length,
      refundTx: fakeTxHash('refund'),
    });
  }
}

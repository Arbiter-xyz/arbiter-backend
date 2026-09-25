import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';
import { numericToleranceVote, describeTolerance } from './consensus.js';

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Groups submissions by normalized answer text, in first-seen order. */
export function groupByNormalizedAnswer(submissions) {
  const groups = new Map(); // normalized -> { representative, workerIds }
  for (const { workerId, answer } of submissions) {
    const norm = normalize(answer);
    if (!groups.has(norm)) groups.set(norm, { representative: answer, workerIds: [] });
    groups.get(norm).workerIds.push(workerId);
  }
  return [...groups.values()];
}

export function exactMatchVote(submissions) {
  let winner = null;
  for (const group of groupByNormalizedAnswer(submissions)) {
    if (!winner || group.workerIds.length > winner.workerIds.length) winner = group;
  }

  return {
    consensus: winner.representative,
    confidence: winner.workerIds.length / submissions.length,
    matchingWorkerIds: winner.workerIds,
    allAgree: winner.workerIds.length === submissions.length,
  };
}

/**
 * Splits an escrowed amount into per-worker payout shares plus the platform
 * fee, guaranteeing the fund-accounting invariant that the sum of all
 * payouts plus the platform fee never exceeds (and, up to integer dust,
 * exactly equals) the escrowed amount. This is the single source of truth
 * for payout math so the property-based suite can fuzz it directly.
 *
 * `payoutShare` is the per-worker amount (floored to whole units), `dust`
 * is the leftover that cannot be evenly divided, and `platformFee` is the
 * fee taken off the top. The invariant asserted by the fuzz suite is:
 *   payoutShare * workerCount + platformFee + dust === escrowedAmount
 * for every generated input, including extreme worker counts and boundary
 * fee rates.
 */
export function splitEscrow(escrowedAmount, workerCount, platformFeeRate = 0) {
  if (!Number.isFinite(escrowedAmount) || escrowedAmount < 0) {
    throw new RangeError('escrowedAmount must be a finite non-negative number');
  }
  if (!Number.isInteger(workerCount) || workerCount <= 0) {
    throw new RangeError('workerCount must be a positive integer');
  }
  if (!Number.isFinite(platformFeeRate) || platformFeeRate < 0 || platformFeeRate > 1) {
    throw new RangeError('platformFeeRate must be a finite number in [0, 1]');
  }

  const platformFee = Math.floor(escrowedAmount * platformFeeRate);
  const distributable = escrowedAmount - platformFee;
  const payoutShare = Math.floor(distributable / workerCount);
  const dust = distributable - payoutShare * workerCount;

  return { payoutShare, platformFee, dust, workerCount };
}

const REPORT_CONSENSUS_TOOL = {
  name: 'report_consensus',
  description:
    'Report the reconciled consensus answer across multiple human worker submissions for the same question.',
  input_schema: {
    type: 'object',
    properties: {
      consensus: { type: 'string', description: 'The single best consensus answer text.' },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence 0-1 that this is the correct majority answer.',
      },
      matching_worker_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "IDs of workers whose answers match the winning plurality (paraphrases count as matches).",
      },
    },
    required: ['consensus', 'confidence', 'matching_worker_ids'],
  },
};

let anthropicClient = null;
function getClient() {
  if (!config.anthropicApiKey) return null;
  if (!anthropicClient) {
    // The SDK's own defaults (2 retries, but a 10-MINUTE timeout) are tuned
    // for long-running batch/agentic use, not a call sitting in the
    // critical path of settling a question with a fail-closed fallback
    // waiting behind it. Keep the SDK's built-in retry (it already handles
    // backoff + which errors are retryable correctly) but cut the ceiling
    // down to something that fails fast enough to still hit the
    // deterministic vote fallback promptly if Claude is genuinely down.
    anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 15_000, maxRetries: 2 });
  }
  return anthropicClient;
}

async function reconcileWithClaude(question, submissions, rule) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const submissionsText = submissions.map((s) => `Worker ${s.workerId}: "${s.answer}"`).join('\n');
  // Only non-default rules add anything to the prompt, so the default
  // mode's Claude call is unchanged.
  const ruleText =
    rule?.mode === 'numeric-tolerance'
      ? ` The asker requested numeric matching: treat numeric answers ${describeTolerance(rule.tolerance)} as matches.`
      : '';

  const message = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 512,
    tool_choice: { type: 'tool', name: 'report_consensus' },
    tools: [REPORT_CONSENSUS_TOOL],
    messages: [
      {
        role: 'user',
        content:
          `Question: "${question}"\n\nWorker answers:\n${submissionsText}\n\n` +
          'Reconcile these into a single consensus answer. Treat paraphrases, case ' +
          'differences, and whitespace differences as matches. If the workers genuinely ' +
          "disagree, pick the winning plurality, lower the confidence accordingly, and only " +
          "list the winning plurality's worker ids in matching_worker_ids." +
          ruleText,
      },
    ],
  });

  const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_consensus');
  if (!toolUse) throw new Error('Claude did not return a report_consensus tool call');

  const { consensus, confidence, matching_worker_ids: matchingWorkerIds } = toolUse.input;
  return { consensus, confidence, matchingWorkerIds, method: 'claude' };
}

const REPORT_DRAFT_TOOL = {
  name: 'report_draft',
  description: 'Report a direct draft answer to a question, with a self-assessed confidence.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The best direct answer to the question.' },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Self-assessed confidence 0-1 that this answer is correct.',
      },
    },
    required: ['answer', 'confidence'],
  },
};

/**
 * The `instant` tier's entire fulfillment path — no worker submissions
 * exist to reconcile, this generates the answer directly. Deliberately a
 * separate function from reconcile()/reconcileWithClaude() rather than
 * calling reconcile() with zero submissions: that path already means
 * "nobody answered, refund," which is exactly the wrong behavior here.
 * Never throws; oracle.js's instant-tier branch treats a null return the
 * same as any other unable-to-answer case (refund, fail closed).
 */
export async function draftAnswer(question, questionId) {
  const client = getClient();
  if (!client) {
    logger.warn({ questionId }, 'instant tier requested but ANTHROPIC_API_KEY not configured');
    return null;
  }

  try {
    const message = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 512,
      tool_choice: { type: 'tool', name: 'report_draft' },
      tools: [REPORT_DRAFT_TOOL],
      messages: [{ role: 'user', content: `Question: "${question}"\n\nGive your best direct answer.` }],
    });

    const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_draft');
    if (!toolUse) return null;

    const { answer, confidence } = toolUse.input;
    return { consensus: answer, confidence, matchingWorkerIds: [], method: 'llm-draft' };
  } catch (err) {
    logger.error({ err, questionId }, 'instant-tier draft answer failed');
    return null;
  }
}

/**
 * reconcile() never throws and never hangs indefinitely on an external API
 * outage — any Claude error falls back to a deterministic vote so the
 * caller can always settle the escrow one way or the other.
 *
 * Fast path: if every worker's answer normalizes identically AND every one
 * of those workers is reputation-established (see dispatch.js's
 * isEstablishedWorker), there is nothing for an LLM to adjudicate — skip
 * Claude and save the latency/cost. The established-only restriction
 * matters: unanimous agreement only proves consensus, never correctness, so
 * a quorum stuffed with fresh (possibly sybil) identities racing to submit
 * the same wrong answer would otherwise sail through with zero scrutiny.
 * Requiring history from every matching worker forces that attack to first
 * spend many honest-looking questions building up reputation before it can
 * ever hit the frictionless path — it doesn't eliminate a sufficiently
 * patient attacker, but it's no longer free. Any quorum containing a fresh
 * identity still gets Claude's (weak, non-guaranteed, but nonzero)
 * plausibility read, same as a genuine disagreement would.
 *
 * `rule` is the question's consensus rule (see consensus.js); null/omitted
 * means the default exact-match mode. 'numeric-tolerance' swaps
 * exactMatchVote() for numericToleranceVote(), and everything else is the
 * same: the established-worker fast path when everyone is within
 * tolerance, and Claude (then the vote) for genuine disagreement.
 */
export async function reconcile(question, submissions, questionId, rule = null) {
  if (submissions.length === 0) {
    return { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' };
  }

  const numeric = rule?.mode === 'numeric-tolerance';
  const vote = numeric
    ? numericToleranceVote(submissions, rule.tolerance, groupByNormalizedAnswer)
    : exactMatchVote(submissions);
  const methodPrefix = numeric ? 'numeric-tolerance' : 'exact-match';
  const allEstablished = submissions.every((s) => s.established);

  if (vote.allAgree && allEstablished) {
    return {
      consensus: vote.consensus,
      confidence: 1,
      matchingWorkerIds: vote.matchingWorkerIds,
      method: `${methodPrefix}-fastpath`,
    };
  }

  try {
    return await reconcileWithClaude(question, submissions, rule);
  } catch (err) {
    logger.error({ err, questionId }, `Claude reconciliation failed, falling back to ${methodPrefix} vote`);
    return {
      consensus: vote.consensus,
      confidence: vote.confidence,
      matchingWorkerIds: vote.matchingWorkerIds,
      method: `${methodPrefix}-fallback`,
    };
  }
}

/**
 * Crash-safe settlement recovery.
 *
 * Runs on backend startup and reconciles every non-terminal job against the
 * live on-chain question status before any settlement work resumes. The
 * on-chain question status is the single source of truth: a job whose
 * question is already resolved/refunded on-chain is marked terminal locally
 * without ever re-issuing resolve()/refund(), and a job that was mid-
 * fulfillOracleCall when the process died is re-driven from its persisted
 * phase rather than blindly retried.
 *
 * The recovery routine is idempotent: it only ever calls resolve()/refund()
 * for jobs whose on-chain status is still Open, and it re-reads that status
 * immediately before each call so a concurrent settle (or a crash between
 * the read and the call) can never produce a duplicate settlement.
 */
export const TERMINAL_JOB_STATES = ['resolved', 'refunded', 'failed'];

export function isTerminalJob(job) {
  return !job || TERMINAL_JOB_STATES.includes(job.state);
}

/**
 * Map an on-chain question status to the terminal job state it implies, or
 * null if the question is still open and settlement must proceed.
 */
export function terminalStateForOnChainStatus(status) {
  switch (status) {
    case 'Resolved':
      return 'resolved';
    case 'Refunded':
      return 'refunded';
    case 'Open':
      return null;
    default:
      // Unknown/absent status: fail closed, do not settle.
      return null;
  }
}

/**
 * Reconcile a single non-terminal job against live on-chain state.
 *
 * `deps` is injected so this is unit/chaos-testable without a live chain:
 *   - getOnChainStatus(questionId) -> 'Open' | 'Resolved' | 'Refunded'
 *   - settleResolved(job) / settleRefunded(job) -> perform the on-chain call
 *   - markTerminal(job, state) -> persist the terminal state locally
 *
 * Returns the terminal state the job ended in. Never calls resolve()/
 * refund() when the question is already settled on-chain, and re-checks the
 * status immediately before settling to close the crash window between the
 * initial read and the call.
 */
export async function reconcileJob(job, deps) {
  const { getOnChainStatus, settleResolved, settleRefunded, markTerminal } = deps;

  if (isTerminalJob(job)) return job.state;

  const status = await getOnChainStatus(job.questionId);
  const terminal = terminalStateForOnChainStatus(status);
  if (terminal) {
    // Already settled on-chain before the crash — adopt the on-chain truth
    // locally without re-issuing any settlement call.
    await markTerminal(job, terminal);
    return terminal;
  }

  // Question is still Open. Re-check immediately before settling so a
  // concurrent settle (or a crash between the read and the call) cannot
  // produce a duplicate resolve()/refund().
  const recheck = await getOnChainStatus(job.questionId);
  const recheckTerminal = terminalStateForOnChainStatus(recheck);
  if (recheckTerminal) {
    await markTerminal(job, recheckTerminal);
    return recheckTerminal;
  }

  // Still Open: safe to settle exactly once. A job that was mid-
  // fulfillOracleCall when the process died is re-driven from its persisted
  // phase; the on-chain status check above guarantees we never double-settle.
  if (job.phase === 'refund' || job.outcome === 'refund') {
    await settleRefunded(job);
    await markTerminal(job, 'refunded');
    return 'refunded';
  }

  await settleResolved(job);
  await markTerminal(job, 'resolved');
  return 'resolved';
}

/**
 * Startup recovery: reconcile every non-terminal job against live on-chain
 * question status before resuming any settlement work. Idempotent and safe
 * to run on every boot; a job already terminal locally is skipped, and a
 * job already settled on-chain is adopted without a duplicate call.
 */
export async function recoverInFlightJobs(jobs, deps) {
  const results = [];
  for (const job of jobs) {
    if (isTerminalJob(job)) continue;
    try {
      const state = await reconcileJob(job, deps);
      results.push({ questionId: job.questionId, state });
    } catch (err) {
      logger.error({ err, questionId: job.questionId }, 'settlement recovery failed for job');
      results.push({ questionId: job.questionId, state: null, error: err.message });
    }
  }
  return results;
}

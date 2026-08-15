import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function exactMatchVote(submissions) {
  const groups = new Map(); // normalized -> { representative, workerIds }
  for (const { workerId, answer } of submissions) {
    const norm = normalize(answer);
    if (!groups.has(norm)) groups.set(norm, { representative: answer, workerIds: [] });
    groups.get(norm).workerIds.push(workerId);
  }

  let winner = null;
  for (const group of groups.values()) {
    if (!winner || group.workerIds.length > winner.workerIds.length) winner = group;
  }

  return {
    consensus: winner.representative,
    confidence: winner.workerIds.length / submissions.length,
    matchingWorkerIds: winner.workerIds,
    allAgree: winner.workerIds.length === submissions.length,
  };
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

async function reconcileWithClaude(question, submissions) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const submissionsText = submissions.map((s) => `Worker ${s.workerId}: "${s.answer}"`).join('\n');

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
          "list the winning plurality's worker ids in matching_worker_ids.",
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
 */
export async function reconcile(question, submissions, questionId) {
  if (submissions.length === 0) {
    return { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' };
  }

  const vote = exactMatchVote(submissions);
  const allEstablished = submissions.every((s) => s.established);

  if (vote.allAgree && allEstablished) {
    return {
      consensus: vote.consensus,
      confidence: 1,
      matchingWorkerIds: vote.matchingWorkerIds,
      method: 'exact-match-fastpath',
    };
  }

  try {
    return await reconcileWithClaude(question, submissions);
  } catch (err) {
    logger.error({ err, questionId }, 'Claude reconciliation failed, falling back to exact-match vote');
    return {
      consensus: vote.consensus,
      confidence: vote.confidence,
      matchingWorkerIds: vote.matchingWorkerIds,
      method: 'exact-match-fallback',
    };
  }
}

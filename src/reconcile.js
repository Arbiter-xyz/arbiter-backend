import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';
import { exactMatchVote } from './vote.js';

export { exactMatchVote } from './vote.js';

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

/**
 * Builds the exact Messages API request body used for reconciliation. Pure
 * and exported so provenance.js (and any third-party verifier) can rebuild
 * it from the committed submissions and confirm, byte for byte, that the
 * prompt Claude actually saw contained exactly those submissions.
 */
export function buildReconcileRequest(question, submissions, model = config.anthropicModel) {
  const submissionsText = submissions.map((s) => `Worker ${s.workerId}: "${s.answer}"`).join('\n');
  return {
    model,
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
  };
}

/** The parts of a Messages API response worth preserving for provenance —
 * enough to re-read the tool call, without SDK-internal fields. */
function captureResponse(message) {
  return { id: message.id, model: message.model, stop_reason: message.stop_reason, content: message.content };
}

async function reconcileWithClaude(question, submissions) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const request = buildReconcileRequest(question, submissions);
  const message = await client.messages.create(request);

  const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_consensus');
  if (!toolUse) throw new Error('Claude did not return a report_consensus tool call');

  const { consensus, confidence, matching_worker_ids: matchingWorkerIds } = toolUse.input;
  return { consensus, confidence, matchingWorkerIds, method: 'claude', llm: { request, response: captureResponse(message) } };
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

/** Same idea as buildReconcileRequest(): the exact instant-tier request
 * body, rebuildable by a verifier from the committed question alone. */
export function buildDraftRequest(question, model = config.anthropicModel) {
  return {
    model,
    max_tokens: 512,
    tool_choice: { type: 'tool', name: 'report_draft' },
    tools: [REPORT_DRAFT_TOOL],
    messages: [{ role: 'user', content: `Question: "${question}"\n\nGive your best direct answer.` }],
  };
}

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
    const request = buildDraftRequest(question);
    const message = await client.messages.create(request);

    const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_draft');
    if (!toolUse) return null;

    const { answer, confidence } = toolUse.input;
    return {
      consensus: answer,
      confidence,
      matchingWorkerIds: [],
      method: 'llm-draft',
      llm: { request, response: captureResponse(message) },
    };
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
      // Kept for provenance: why the LLM wasn't used. The vote itself needs
      // nothing but the submissions to re-derive.
      llmError: err.message,
    };
  }
}

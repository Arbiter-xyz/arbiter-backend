import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { describeTolerance } from './consensus.js';

/**
 * Provider-agnostic LLM interface used by reconcile.js. Every provider exposes:
 *
 *   isConfigured()                              -> boolean
 *   reportConsensus(question, submissions, rule) -> { consensus, confidence, matchingWorkerIds, llm }
 *   reportDraft(question)                       -> { answer, confidence, llm } | null
 *
 * `llm` is the provider's own request/response record, kept for provenance.js
 * and provenanceVerify.js. reportConsensus() throws on any failure so the
 * caller can fall back to the deterministic vote; reportDraft() resolves null
 * when the model returns no usable answer.
 */

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
 * Builds the exact Messages API request body used for reconciliation. Pure
 * and exported so provenance.js (and any third-party verifier) can rebuild
 * it from the committed submissions and confirm, byte for byte, that the
 * prompt Claude actually saw contained exactly those submissions.
 */
export function buildReconcileRequest(question, submissions, model = config.anthropicModel, rule = null) {
  const submissionsText = submissions.map((s) => `Worker ${s.workerId}: "${s.answer}"`).join('\n');
  // Only non-default rules add anything to the prompt, so the default
  // mode's Claude call is unchanged.
  const ruleText =
    rule?.mode === 'numeric-tolerance'
      ? ` The asker requested numeric matching: treat numeric answers ${describeTolerance(rule.tolerance)} as matches.`
      : '';
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
          "list the winning plurality's worker ids in matching_worker_ids." +
          ruleText,
      },
    ],
  };
}

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

/** The parts of a Messages API response worth preserving for provenance —
 * enough to re-read the tool call, without SDK-internal fields. */
function captureResponse(message) {
  return { id: message.id, model: message.model, stop_reason: message.stop_reason, content: message.content };
}

let anthropicClient = null;
export function getClient() {
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

const anthropicProvider = {
  name: 'anthropic',

  isConfigured() {
    return getClient() !== null;
  },

  async reportConsensus(question, submissions, rule = null) {
    const client = getClient();
    if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

    const request = buildReconcileRequest(question, submissions, config.anthropicModel, rule);
    const message = await client.messages.create(request);

    const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_consensus');
    if (!toolUse) throw new Error('Claude did not return a report_consensus tool call');

    const { consensus, confidence, matching_worker_ids: matchingWorkerIds } = toolUse.input;
    return { consensus, confidence, matchingWorkerIds, llm: { request, response: captureResponse(message) } };
  },

  async reportDraft(question) {
    const client = getClient();
    if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

    const request = buildDraftRequest(question);
    const message = await client.messages.create(request);

    const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_draft');
    if (!toolUse) return null;

    const { answer, confidence } = toolUse.input;
    return { answer, confidence, llm: { request, response: captureResponse(message) } };
  },
};

const providers = { anthropic: anthropicProvider };

// Resolved once at import so a misconfigured LLM_PROVIDER fails startup
// loudly instead of silently degrading every reconciliation to the vote.
export const llmProvider = providers[config.llmProvider];
if (!llmProvider) {
  throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}" (supported: ${Object.keys(providers).join(', ')})`);
}

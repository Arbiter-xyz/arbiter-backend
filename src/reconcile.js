import { config } from './config.js';
import { logger } from './logger.js';
import { numericToleranceVote } from './consensus.js';
import { llmProvider, buildReconcileRequest, buildDraftRequest } from './llmProvider.js';

export { buildReconcileRequest, buildDraftRequest, getClient } from './llmProvider.js';

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common filler words that carry no answer content. Stripped before
// similarity comparison so "the answer is 42" and "42" cluster together.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'and', 'or', 'as', 'so', 'answer', 'answers',
  'result', 'results', 'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our',
  'your', 'their', 'think', 'believe', 'say', 'said', 'says', 'would', 'will',
]);

function tokenize(text) {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Cheap string-similarity heuristic used to cluster near-duplicate answers
 * before voting. We deliberately avoid an embedding call here: reconcile()
 * sits in the critical path of settling escrow with a fail-closed fallback
 * behind it, and a synchronous, dependency-free heuristic keeps that path
 * fast and deterministic. Token-set Jaccard similarity over content words
 * (stopwords stripped) captures the common paraphrase cases — "42" vs
 * "the answer is 42", casing/whitespace/punctuation differences — while
 * still separating genuinely different answers.
 */
function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  const setA = new Set(ta);
  const setB = new Set(tb);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Above this Jaccard threshold two answers are treated as the same cluster.
// Tuned conservatively: too low merges genuinely different answers (a
// correctness risk), too high fails to merge obvious paraphrases (the
// quality problem this issue targets).
const CLUSTER_THRESHOLD = 0.6;

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

export { exactMatchVote } from './vote.js';

/**
 * Cluster raw submissions by semantic similarity, then vote on clusters
 * rather than raw strings. A cluster's size (not any single string's exact
 * match count) is what counts toward quorum agreement, so "42" and "the
 * answer is 42" reinforce the same quorum instead of fracturing it.
 *
 * Clustering is greedy and order-dependent: each submission joins the
 * first existing cluster whose representative it is similar enough to,
 * otherwise it seeds a new cluster. The representative is the first
 * submission seen for that cluster. This is deterministic for a given
 * submission order and cheap (O(n^2) similarity checks over a small n).
 */
export function clusterVote(submissions) {
  const clusters = []; // { representative, workerIds }

  for (const { workerId, answer } of submissions) {
    let joined = false;
    for (const cluster of clusters) {
      if (similarity(answer, cluster.representative) >= CLUSTER_THRESHOLD) {
        cluster.workerIds.push(workerId);
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ representative: answer, workerIds: [workerId] });
  }

  let winner = null;
  for (const cluster of clusters) {
    if (!winner || cluster.workerIds.length > winner.workerIds.length) winner = cluster;
  }

  return {
    consensus: winner.representative,
    confidence: winner.workerIds.length / submissions.length,
    matchingWorkerIds: winner.workerIds,
    allAgree: winner.workerIds.length === submissions.length,
    clusterCount: clusters.length,
  };
}

async function reconcileWithClaude(question, submissions, rule = null) {
  const { consensus, confidence, matchingWorkerIds, llm } = await llmProvider.reportConsensus(question, submissions, rule);
  return { consensus, confidence, matchingWorkerIds, method: 'claude', llm };
}

async function draftWithClaude(question) {
  const draft = await llmProvider.reportDraft(question);
  if (!draft) throw new Error(`LLM provider "${llmProvider.name}" did not return a report_draft tool call`);
  return {
    consensus: draft.answer,
    confidence: draft.confidence,
    matchingWorkerIds: [],
    method: 'llm-draft',
    llm: draft.llm,
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// Same ceiling as the Anthropic client. No SDK-style retry here: a failed
// OpenAI call falls through to the next tier instead of retrying in place.
const OPENAI_TIMEOUT_MS = 15_000;

/** Re-expresses a Messages API request (tool + prompt) as the equivalent
 * Chat Completions request, forcing the same tool, so both providers see
 * the same prompt and return the same shape. */
function openAIToolRequest(model, anthropicRequest) {
  const [tool] = anthropicRequest.tools;
  return {
    model,
    max_completion_tokens: anthropicRequest.max_tokens,
    tool_choice: { type: 'function', function: { name: tool.name } },
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
    messages: anthropicRequest.messages,
  };
}

/** The OpenAI Chat Completions analogue of buildReconcileRequest(). */
export function buildOpenAIReconcileRequest(question, submissions, model = config.openaiModel, rule = null) {
  return openAIToolRequest(model, buildReconcileRequest(question, submissions, config.anthropicModel, rule));
}

/** The OpenAI analogue of buildDraftRequest(), for the instant tier's fallback. */
export function buildOpenAIDraftRequest(question, model = config.openaiModel) {
  return openAIToolRequest(model, buildDraftRequest(question));
}

async function postOpenAI(request) {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI API returned HTTP ${res.status}`);
  return res.json();
}

/** Normalizes an OpenAI completion's function calls into the same tool_use
 * block shape llmProvider.js keeps for Claude, so provenance stores and the
 * verifier re-read both providers' tool calls identically. Throws on
 * malformed tool arguments, which the dispatcher treats as a failed attempt. */
function captureOpenAIResponse(completion) {
  const choice = completion.choices?.[0];
  const calls = choice?.message?.tool_calls || [];
  return {
    id: completion.id,
    model: completion.model,
    stop_reason: choice?.finish_reason ?? null,
    content: calls
      .filter((c) => c.type === 'function')
      .map((c) => ({ type: 'tool_use', name: c.function.name, input: JSON.parse(c.function.arguments) })),
  };
}

async function reconcileWithOpenAI(question, submissions, rule = null) {
  const request = buildOpenAIReconcileRequest(question, submissions, config.openaiModel, rule);
  const response = captureOpenAIResponse(await postOpenAI(request));

  const toolUse = response.content.find((b) => b.name === 'report_consensus');
  if (!toolUse) throw new Error('OpenAI did not return a report_consensus tool call');

  const { consensus, confidence, matching_worker_ids: matchingWorkerIds } = toolUse.input;
  if (typeof consensus !== 'string' || !Array.isArray(matchingWorkerIds)) {
    throw new Error('OpenAI report_consensus tool call was missing required fields');
  }
  return { consensus, confidence, matchingWorkerIds, method: 'openai', llm: { request, response } };
}

async function draftWithOpenAI(question) {
  const request = buildOpenAIDraftRequest(question);
  const response = captureOpenAIResponse(await postOpenAI(request));

  const toolUse = response.content.find((b) => b.name === 'report_draft');
  if (!toolUse) throw new Error('OpenAI did not return a report_draft tool call');

  const { answer, confidence } = toolUse.input;
  if (typeof answer !== 'string') throw new Error('OpenAI report_draft tool call was missing an answer');
  return {
    consensus: answer,
    confidence,
    matchingWorkerIds: [],
    method: 'llm-draft-openai',
    llm: { request, response },
  };
}

/**
 * LLM providers in fallback order, primary first. An unconfigured provider
 * is skipped; a configured one that throws (transport error, timeout, or a
 * missing/malformed tool call) hands off to the next. Only when every
 * configured provider has failed does the caller use its deterministic path.
 */
const RECONCILE_PROVIDERS = [
  { configured: () => llmProvider.isConfigured(), run: reconcileWithClaude },
  { configured: () => Boolean(config.openaiApiKey), run: reconcileWithOpenAI },
];

const DRAFT_PROVIDERS = [
  { configured: () => llmProvider.isConfigured(), run: draftWithClaude },
  { configured: () => Boolean(config.openaiApiKey), run: draftWithOpenAI },
];

/**
 * The `instant` tier's entire fulfillment path — no worker submissions
 * exist to reconcile, this generates the answer directly. Deliberately a
 * separate function from reconcile()/reconcileWithClaude() rather than
 * calling reconcile() with zero submissions: that path already means
 * "nobody answered, refund," which is exactly the wrong behavior here.
 * Never throws; oracle.js's instant-tier branch treats a null return the
 * same as any other unable-to-answer case (refund, fail closed).
 *
 * Also reused for worker-facing draft suggestions on human-quorum tiers
 * (see oracle.js's fulfillOracleCall); `purpose` only labels the logs.
 */
export async function draftAnswer(question, questionId, { purpose = 'instant-tier' } = {}) {
  if (!DRAFT_PROVIDERS.some((p) => p.configured())) {
    logger.warn({ questionId, purpose }, `${purpose} draft requested but no LLM provider configured`);
    return null;
  }

  for (const provider of DRAFT_PROVIDERS) {
    if (!provider.configured()) continue;
    try {
      return await provider.run(question);
    } catch (err) {
      logger.error({ err, questionId, purpose }, `${purpose} draft answer failed, trying next provider`);
    }
  }
  return null;
}

/**
 * reconcile() never throws and never hangs indefinitely on an external API
 * outage — LLM providers are tried in order (Claude, then OpenAI), and only
 * when every configured one has failed does it fall back to a deterministic
 * vote so the caller can always settle the escrow one way or the other.
 *
 * Fast path: if every worker's answer clusters together (near-duplicate
 * phrasing counts as agreement) AND every one of those workers is
 * reputation-established (see dispatch.js's isEstablishedWorker), there is
 * nothing for an LLM to adjudicate — skip Claude and save the
 * latency/cost. The established-only restriction matters: unanimous
 * agreement only proves consensus, never correctness, so a quorum stuffed
 * with fresh (possibly sybil) identities racing to submit the same wrong
 * answer would otherwise sail through with zero scrutiny. Requiring
 * history from every matching worker forces that attack to first spend
 * many honest-looking questions building up reputation before it can ever
 * hit the frictionless path — it doesn't eliminate a sufficiently patient
 * attacker, but it's no longer free. Any quorum containing a fresh
 * identity still gets Claude's (weak, non-guaranteed, but nonzero)
 * plausibility read, same as a genuine disagreement would.
 *
 * Fail-closed guarantee: clustering is a heuristic, so it is only trusted
 * for the frictionless fast path when it is unambiguous (every submission
 * lands in a single cluster). Any split clustering — including one caused
 * by a borderline similarity score — falls through to the Claude-assisted
 * review path rather than silently resolving on a fuzzy match.
 */
export async function reconcile(question, submissions, questionId, rule = null) {
  if (submissions.length === 0) {
    return { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' };
  }

  const numeric = rule?.mode === 'numeric-tolerance';
  const vote = numeric
    ? numericToleranceVote(submissions, rule.tolerance, groupByNormalizedAnswer)
    : clusterVote(submissions);
  const allEstablished = submissions.every((s) => s.established);

  if (vote.allAgree && allEstablished) {
    return {
      consensus: vote.consensus,
      confidence: 1,
      matchingWorkerIds: vote.matchingWorkerIds,
      method: 'cluster-fastpath',
    };
  }

  for (const provider of RECONCILE_PROVIDERS) {
    if (!provider.configured()) continue;
    try {
      return await provider.run(question, submissions, rule);
    } catch (err) {
      logger.error({ err, questionId }, 'LLM reconciliation failed, trying next provider');
    }
  }

  logger.error({ questionId }, 'no LLM reconciliation provider answered, falling back to cluster vote');
  return {
    consensus: vote.consensus,
    confidence: vote.confidence,
    matchingWorkerIds: vote.matchingWorkerIds,
    method: 'cluster-fallback',
  };
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

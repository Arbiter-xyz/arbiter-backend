import { logger } from './logger.js';
import { numericToleranceVote } from './consensus.js';
import { llmProvider } from './llmProvider.js';

export { buildReconcileRequest, buildDraftRequest } from './llmProvider.js';

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

/**
 * Guards the on-chain credit path: every worker id the reconciliation step
 * claims matched must correspond to a real submission for this question.
 * A model (or a prompt-injected model) naming an id that never answered
 * would otherwise be resolve()'d and credited real money for a quorum it
 * never participated in. We treat any unknown id as a hard error rather
 * than silently filtering it out — an unknown id means the reconciliation
 * step itself is untrustworthy, and the fee/slash split computed from a
 * filtered worker count would be wrong anyway. Throws so the caller aborts
 * settlement (fail closed) instead of crediting anyone.
 */
export function assertMatchingWorkerIdsAreReal(matchingWorkerIds, submissions, questionId) {
  const realWorkerIds = new Set(submissions.map((s) => s.workerId));
  const unknown = (matchingWorkerIds || []).filter((id) => !realWorkerIds.has(id));
  if (unknown.length > 0) {
    logger.error(
      { questionId, unknownWorkerIds: unknown, realWorkerIds: [...realWorkerIds] },
      'reconciliation named worker ids with no matching submission; aborting settlement',
    );
    throw new Error(
      `reconciliation returned unknown worker id(s) not in submissions: ${unknown.join(', ')}`,
    );
  }
  return matchingWorkerIds;
}

async function reconcileWithClaude(question, submissions, rule = null) {
  const { consensus, confidence, matchingWorkerIds, llm } = await llmProvider.reportConsensus(question, submissions, rule);
  assertMatchingWorkerIdsAreReal(matchingWorkerIds, submissions, question?.id);
  return { consensus, confidence, matchingWorkerIds, method: 'claude', llm };
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
  { configured: () => Boolean(config.anthropicApiKey), run: reconcileWithClaude },
  { configured: () => Boolean(config.openaiApiKey), run: reconcileWithOpenAI },
];

const DRAFT_PROVIDERS = [
  { configured: () => Boolean(config.anthropicApiKey), run: draftWithClaude },
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
  if (!llmProvider.isConfigured()) {
    logger.warn({ questionId, purpose }, `${purpose} draft requested but LLM provider "${llmProvider.name}" not configured`);
    return null;
  }

  try {
    const draft = await llmProvider.reportDraft(question);
    if (!draft) return null;

    return {
      consensus: draft.answer,
      confidence: draft.confidence,
      matchingWorkerIds: [],
      method: 'llm-draft',
      llm: draft.llm,
    };
  } catch (err) {
    logger.error({ err, questionId, purpose }, `${purpose} draft answer failed`);
    return null;
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
 * agreement o

/* … truncated 6495 chars — edit only what you need near the top … */

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

// ---------------------------------------------------------------------------
// Predictive quorum sizing (issue #121)
//
// `quorumSize` used to be a fixed constant per tier. We now predict it from
// signals available at quote time (before any worker has looked at the
// question) so easy questions settle with less dispatch overhead while
// harder ones raise the bar. This is a documented heuristic, not trained ML:
// the codebase has no training/serving infra, and a pure, deterministic
// scoring function is independently testable like surgeMultiplier().
//
// The prediction is clamped to a configured min/max so a bad prediction can
// never produce quorumSize 0 (which would break dispatchAndCollect()'s
// `submissions.size >= quorumSize` finish condition) or an unreasonably
// large one. The clamp floor is always >= 1.
// ---------------------------------------------------------------------------

const QUORUM_PREDICTION_CONFIG = {
  min: 2,
  max: 7,
  // Baseline quorum before any difficulty signal is applied.
  base: 3,
  // Question-length thresholds (in tokens) that nudge difficulty up.
  longQuestionTokens: 40,
  veryLongQuestionTokens: 120,
};

/**
 * Pure function: predict a quorum size from quote-time signals.
 *
 * Available signals (all known before dispatch):
 *   - question: the raw question text (length is a difficulty proxy)
 *   - category: optional category label
 *   - categoryHistory: optional per-category stats, e.g.
 *       { reconciliationMethodDistribution: { claude: 0.6, vote: 0.4 } }
 *     A high share of `claude` (LLM adjudication) means the category tends
 *     to need scrutiny, so we raise the quorum.
 *
 * Returns an integer clamped to [config.min, config.max]. Never returns 0.
 */
export function predictQuorumSize(question, { category = null, categoryHistory = null, config = QUORUM_PREDICTION_CONFIG } = {}) {
  const cfg = { ...QUORUM_PREDICTION_CONFIG, ...config };
  let score = cfg.base;

  // Length signal: longer questions tend to be more involved.
  const tokenCount = typeof question === 'string' ? tokenize(question).length : 0;
  if (tokenCount >= cfg.veryLongQuestionTokens) score += 2;
  else if (tokenCount >= cfg.longQuestionTokens) score += 1;

  // Category-history signal: fraction of past reconciliations that needed
  // LLM adjudication (method 'claude'). Higher => harder => larger quorum.
  const dist = categoryHistory?.reconciliationMethodDistribution;
  if (dist && typeof dist === 'object') {
    const claudeShare = Number(dist.claude) || 0;
    if (claudeShare >= 0.5) score += 2;
    else if (claudeShare >= 0.25) score += 1;
  }

  // Clamp: floor is at least 1 so the finish condition can always be met.
  const min = Math.max(1, Math.floor(cfg.min));
  const max = Math.max(min, Math.floor(cfg.max));
  const clamped = Math.min(max, Math.max(min, Math.round(score)));
  return clamped;
}

async function reconcileWithClaude(question, submissions, rule = null) {
  const { consensus, confidence, matchingWorkerIds, llm } = await llmProvider.reportConsensus(question, submissions, rule);
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

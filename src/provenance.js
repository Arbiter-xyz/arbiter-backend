import { store } from './store.js';
import { PROVENANCE_VERSION, hashRecord } from './provenanceVerify.js';

export {
  PROVENANCE_VERSION,
  canonicalJson,
  hashRecord,
  expectedAction,
  verifyProvenance,
  extractContractCall,
  verifyPayout,
} from './provenanceVerify.js';

/**
 * Tamper-evident provenance for settled answers. Before this, a settled
 * question's answer was only linked to its on-chain resolve() event and the
 * credited worker addresses; the raw worker submissions and any Claude
 * prompt/response that actually produced the consensus weren't preserved,
 * so a disputed answer couldn't be re-derived by anyone.
 *
 * At reconciliation time — before resolve()/refund() is sent — the backend
 * now builds one provenance record holding every raw input (submissions as
 * received, the exact LLM request and response when one was used) plus the
 * result and the resolve/refund decision, and commits to it with
 * sha256(canonicalJson(record)). The hash is written onto the job record
 * (`provenanceHash`), and the full record is public at
 * GET /oracle/:jobId/provenance. Anyone can then:
 *   1. recompute the hash from the record (tamper evidence),
 *   2. re-derive the consensus from the committed inputs alone
 *      (verifyProvenance in provenanceVerify.js; scripts/verify-provenance.js
 *      wraps it), and
 *   3. decode the actual on-chain resolve() transaction and confirm that it
 *      paid exactly the workers the record says it should (verifyPayout).
 *
 * The hash is computed BEFORE settlement on purpose: it's the value a
 * follow-up arbiter-contract change can accept as an extra resolve()
 * argument and store on-chain, which removes the need to trust this
 * backend's copy of the hash at all. Until that lands, the commitment lives
 * on the job record, and step 3 above is what ties it to real money.
 *
 * Trust boundary, stated plainly: each submission's `established` flag
 * (which decides whether the no-LLM fast path is allowed) is this backend's
 * own reputation record. A verifier can confirm the fast path was applied
 * consistently with those flags, but not that the flags themselves are
 * right.
 */

const KEY_PREFIX = 'provenance:';

/**
 * Builds the committed record from everything reconciliation saw and
 * decided. `result` is reconcile()/draftAnswer()'s return value (or a
 * refund placeholder), including its `llm` / `llmError` capture.
 */
export function buildProvenanceRecord({ questionId, question, tier, submissions, result, minConfidence, action, committedAt }) {
  return {
    v: PROVENANCE_VERSION,
    questionId: String(questionId),
    question,
    tier,
    submissions: submissions.map((s) => ({ workerId: s.workerId, answer: s.answer, established: Boolean(s.established) })),
    reconciliation: {
      method: result.method,
      llm: result.llm || null,
      llmError: result.llmError || null,
    },
    result: {
      consensus: result.consensus ?? null,
      confidence: result.confidence ?? 0,
      matchingWorkerIds: result.matchingWorkerIds || [],
    },
    decision: { minConfidence, action },
    committedAt: committedAt || new Date().toISOString(),
  };
}

export async function saveProvenance(questionId, record) {
  const hash = hashRecord(record);
  // No TTL, unlike job records: provenance exists for disputes, which can
  // come long after the job result has expired. Same "must never silently
  // expire" rule this codebase already applies to balances and reputation.
  await store.set(KEY_PREFIX + questionId, { record, hash, settlement: null });
  return hash;
}

/** Settlement facts (outcome, tx hashes) are attached after the fact and
 * are deliberately NOT part of the hash: they don't exist yet when the
 * commitment is made, and they're independently checkable on-chain. */
export async function attachSettlement(questionId, settlement) {
  const entry = await store.get(KEY_PREFIX + questionId);
  if (!entry) return;
  await store.set(KEY_PREFIX + questionId, { ...entry, settlement });
}

export async function getProvenance(questionId) {
  return store.get(KEY_PREFIX + questionId);
}


import { createHash } from 'node:crypto';
import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { exactMatchVote } from './vote.js';

/**
 * The pure, dependency-light half of provenance.js: hashing, re-derivation,
 * and on-chain settlement decoding. Deliberately imports nothing from the
 * backend's runtime (no config, no store, no LLM client), so a third party
 * can run it via scripts/verify-provenance.js with no backend setup at all.
 * See provenance.js for the design and trust model.
 */

export const PROVENANCE_VERSION = 1;

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no
 * insignificant whitespace, ECMAScript number formatting, `undefined`
 * members omitted. For the values in a provenance record (strings, finite
 * numbers, booleans, null, arrays, plain objects) this is exactly RFC 8785
 * (JCS), so a verifier in any language can use an off-the-shelf JCS
 * library instead of this code.
 */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const members = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function hashRecord(record) {
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}

const INSTANT_METHODS = new Set(['llm-draft', 'llm-draft-unavailable']);

/** The same resolve-or-refund rule oracle.js applies, restated as a pure
 * function of committed values so a verifier can re-apply it. */
export function expectedAction({ submissions, reconciliation, result, decision }) {
  if (INSTANT_METHODS.has(reconciliation.method)) return result.consensus ? 'resolve' : 'refund';
  const resolves =
    submissions.length > 0 && result.matchingWorkerIds.length > 0 && result.confidence >= decision.minConfidence;
  return resolves ? 'resolve' : 'refund';
}

function sameMembers(a, b) {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function toolInput(response, toolName) {
  const block = (response?.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
  return block ? block.input : null;
}

/** Re-derives the consensus from the record's inputs alone. Returns a list
 * of `{ name, ok, detail }` checks. */
function rederive(record) {
  const { question, submissions, reconciliation, result } = record;
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const ids = submissions.map((s) => s.workerId);

  switch (reconciliation.method) {
    case 'no-answers':
    case 'llm-draft-unavailable':
      check('no submissions and no consensus', submissions.length === 0 && result.consensus === null);
      break;

    case 'exact-match-fastpath':
    case 'exact-match-fallback': {
      const vote = exactMatchVote(submissions);
      const fastpathEligible = vote.allAgree && submissions.every((s) => s.established);
      const fastpath = reconciliation.method === 'exact-match-fastpath';
      check(
        fastpath ? 'fast path allowed (unanimous, every worker established)' : 'fast path correctly not taken',
        fastpath === fastpathEligible,
      );
      check('consensus matches a fresh exact-match vote', result.consensus === vote.consensus, `vote: ${JSON.stringify(vote.consensus)}`);
      check('matching workers match the vote', sameMembers(result.matchingWorkerIds, vote.matchingWorkerIds));
      check('confidence matches the vote', result.confidence === (fastpath ? 1 : vote.confidence), `vote: ${fastpath ? 1 : vote.confidence}`);
      if (!fastpath) check('LLM failure reason recorded', typeof reconciliation.llmError === 'string');
      break;
    }

    case 'claude': {
      const vote = exactMatchVote(submissions);
      check('fast path correctly not taken', !(vote.allAgree && submissions.every((s) => s.established)));
      const request = reconciliation.llm?.request;
      const prompt = request?.messages?.[0]?.content || '';
      const submissionsBlock = submissions.map((s) => `Worker ${s.workerId}: "${s.answer}"`).join('\n');
      check('LLM prompt contains the committed question', prompt.includes(`Question: "${question}"`));
      check('LLM prompt contains exactly the committed submissions', prompt.includes(`Worker answers:\n${submissionsBlock}\n\n`));
      const input = toolInput(reconciliation.llm?.response, 'report_consensus');
      check('LLM response contains a report_consensus tool call', input !== null);
      if (input) {
        check('consensus matches the LLM tool call', result.consensus === input.consensus);
        check('confidence matches the LLM tool call', result.confidence === input.confidence);
        check('matching workers match the LLM tool call', sameMembers(result.matchingWorkerIds, input.matching_worker_ids || []));
      }
      check(
        'every matching worker actually submitted an answer',
        result.matchingWorkerIds.every((id) => ids.includes(id)),
      );
      break;
    }

    case 'llm-draft': {
      const prompt = reconciliation.llm?.request?.messages?.[0]?.content || '';
      check('no human submissions (instant tier)', submissions.length === 0);
      check('LLM prompt contains the committed question', prompt.includes(`Question: "${question}"`));
      const input = toolInput(reconciliation.llm?.response, 'report_draft');
      check('LLM response contains a report_draft tool call', input !== null);
      if (input) {
        check('answer matches the LLM tool call', result.consensus === input.answer);
        check('confidence matches the LLM tool call', result.confidence === input.confidence);
      }
      break;
    }

    default:
      check(`known reconciliation method (${reconciliation.method})`, false);
  }
  return checks;
}

/**
 * Independent verification of one provenance entry: tamper evidence, then
 * re-derivation, then the resolve/refund decision. Pass `expectedHash` from
 * a source you trust more than the provenance entry itself (the job
 * record's `provenanceHash` today; the on-chain commitment once
 * arbiter-contract stores one).
 */
export function verifyProvenance({ record, hash }, { expectedHash } = {}) {
  const checks = [];
  const recomputed = hashRecord(record);
  checks.push({ name: 'record hash recomputes to the committed hash', ok: recomputed === hash, detail: recomputed });
  if (expectedHash !== undefined) {
    checks.push({ name: 'committed hash matches the independently published hash', ok: expectedHash === hash, detail: expectedHash });
  }
  checks.push({ name: `supported record version (${record.v})`, ok: record.v === PROVENANCE_VERSION, detail: '' });
  if (record.v === PROVENANCE_VERSION) {
    checks.push(...rederive(record));
    const action = expectedAction(record);
    checks.push({ name: `decision (${record.decision.action}) follows from the result`, ok: action === record.decision.action, detail: `expected ${action}` });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Decodes the contract call inside a settlement transaction envelope
 * (base64 XDR or an already-parsed xdr.TransactionEnvelope; fee-bumped
 * envelopes are unwrapped). Returns
 * `{ contractId, functionName, questionId, workers, losingWorkers }`.
 */
export function extractContractCall(envelope) {
  let env = typeof envelope === 'string' ? xdr.TransactionEnvelope.fromXDR(envelope, 'base64') : envelope;
  if (env.switch().name === 'envelopeTypeTxFeeBump') env = env.feeBump().tx().innerTx();
  const tx = env.switch().name === 'envelopeTypeTx' ? env.v1().tx() : env.v0().tx();
  const invoke = tx.operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract();
  const args = invoke.args().map((a) => scValToNative(a));
  return {
    contractId: Address.fromScAddress(invoke.contractAddress()).toString(),
    functionName: invoke.functionName().toString(),
    questionId: args[0] !== undefined ? String(args[0]) : null,
    workers: Array.isArray(args[1]) ? args[1].map(String) : [],
    losingWorkers: Array.isArray(args[2]) ? args[2].map(String) : [],
  };
}

/** Confirms a decoded on-chain settlement call is the one the provenance
 * record says should have happened. */
export function verifyPayout(record, call) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const expectedFn = record.decision.action === 'resolve' ? 'resolve' : 'refund';
  check(`on-chain call is ${expectedFn}()`, call.functionName === expectedFn, `got ${call.functionName}()`);
  check('on-chain question id matches', call.questionId === record.questionId, `got ${call.questionId}`);
  if (call.functionName === 'resolve') {
    if (record.reconciliation.method === 'llm-draft') {
      check('instant tier credits exactly one address (the platform)', call.workers.length === 1 && call.losingWorkers.length === 0);
    } else {
      const matching = record.result.matchingWorkerIds;
      const losing = record.submissions.map((s) => s.workerId).filter((id) => !matching.includes(id));
      check('credited workers are exactly the matching workers', sameMembers(call.workers, matching), call.workers.join(', '));
      check('slashed workers are exactly the non-matching workers', sameMembers(call.losingWorkers, losing), call.losingWorkers.join(', '));
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

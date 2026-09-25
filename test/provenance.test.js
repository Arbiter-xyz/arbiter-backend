import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Contract, Keypair, StrKey, TransactionBuilder, nativeToScVal, Address } from '@stellar/stellar-sdk';
import {
  canonicalJson,
  hashRecord,
  buildProvenanceRecord,
  saveProvenance,
  attachSettlement,
  getProvenance,
  verifyProvenance,
  extractContractCall,
  verifyPayout,
} from '../src/provenance.js';
import { buildReconcileRequest, buildDraftRequest } from '../src/reconcile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSPHRASE = 'Test SDF Network ; September 2015';

function commit(fields) {
  const record = buildProvenanceRecord({ questionId: '42', question: 'Capital of France?', tier: 'standard', minConfidence: 0.6, committedAt: '2026-01-01T00:00:00.000Z', ...fields });
  return { record, hash: hashRecord(record) };
}

function failed(result) {
  return result.checks.filter((c) => !c.ok).map((c) => c.name);
}

/** A realistic Claude reconciliation: the real request builder, and a
 * response shaped like a Messages API tool call. */
function claudeResult(submissions, input) {
  return {
    consensus: input.consensus,
    confidence: input.confidence,
    matchingWorkerIds: input.matching_worker_ids,
    method: 'claude',
    llm: {
      request: buildReconcileRequest('Capital of France?', submissions, 'claude-sonnet-5'),
      response: { id: 'msg_01', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_01', name: 'report_consensus', input }] },
    },
  };
}

const W = (workerId, answer, established = true) => ({ workerId, answer, established });

describe('canonicalJson', () => {
  test('sorts keys at every depth and drops undefined members, so key order never changes the hash', () => {
    const a = { b: 1, a: { d: [1, { z: true, y: null }], c: 'x' }, skip: undefined };
    const b = { a: { c: 'x', d: [1, { y: null, z: true }] }, b: 1 };
    assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(hashRecord(a), hashRecord(b));
  });

  test('rejects values JCS cannot represent', () => {
    assert.throws(() => canonicalJson({ x: NaN }));
    assert.throws(() => canonicalJson({ x: 1n }));
  });
});

describe('verifyProvenance: re-derivation per reconciliation method', () => {
  test('exact-match fast path (unanimous, all established) verifies', () => {
    const submissions = [W('w1', 'Paris'), W('w2', 'paris.'), W('w3', ' PARIS ')];
    const entry = commit({ submissions, result: { consensus: 'Paris', confidence: 1, matchingWorkerIds: ['w1', 'w2', 'w3'], method: 'exact-match-fastpath' }, action: 'resolve' });
    assert.deepEqual(failed(verifyProvenance(entry)), []);
  });

  test('a fast path claimed for a quorum containing a fresh worker fails re-derivation', () => {
    const submissions = [W('w1', 'Paris'), W('w2', 'Paris', false)];
    const entry = commit({ submissions, result: { consensus: 'Paris', confidence: 1, matchingWorkerIds: ['w1', 'w2'], method: 'exact-match-fastpath' }, action: 'resolve' });
    assert.ok(failed(verifyProvenance(entry)).some((n) => n.startsWith('fast path allowed')));
  });

  test('exact-match fallback verifies against a fresh vote, including the fractional confidence', () => {
    const submissions = [W('w1', 'Rust'), W('w2', 'Rust'), W('w3', 'Python')];
    const entry = commit({ submissions, result: { consensus: 'Rust', confidence: 2 / 3, matchingWorkerIds: ['w1', 'w2'], method: 'exact-match-fallback', llmError: 'ANTHROPIC_API_KEY not configured' }, action: 'resolve' });
    assert.deepEqual(failed(verifyProvenance(entry)), []);
  });

  test('Claude reconciliation verifies from the committed prompt and tool call', () => {
    const submissions = [W('w1', 'Paris'), W('w2', 'The capital is Paris', false), W('w3', 'Lyon', false)];
    const entry = commit({ submissions, result: claudeResult(submissions, { consensus: 'Paris', confidence: 0.67, matching_worker_ids: ['w1', 'w2'] }), action: 'resolve' });
    assert.deepEqual(failed(verifyProvenance(entry)), []);
  });

  test('a Claude result that credits a worker who never submitted fails', () => {
    const submissions = [W('w1', 'Paris'), W('w2', 'Lyon', false)];
    const entry = commit({ submissions, result: claudeResult(submissions, { consensus: 'Paris', confidence: 0.9, matching_worker_ids: ['w1', 'ghost'] }), action: 'resolve' });
    assert.ok(failed(verifyProvenance(entry)).includes('every matching worker actually submitted an answer'));
  });

  test('a Claude prompt that did not contain exactly the committed submissions fails', () => {
    const submissions = [W('w1', 'Paris'), W('w2', 'Lyon', false)];
    const result = claudeResult([W('w1', 'Paris'), W('w2', 'Paris', false)], { consensus: 'Paris', confidence: 1, matching_worker_ids: ['w1', 'w2'] });
    const entry = commit({ submissions, result, action: 'resolve' });
    assert.ok(failed(verifyProvenance(entry)).includes('LLM prompt contains exactly the committed submissions'));
  });

  test('instant tier (llm-draft) verifies from the committed draft tool call', () => {
    const result = {
      consensus: 'Paris',
      confidence: 0.95,
      matchingWorkerIds: [],
      method: 'llm-draft',
      llm: {
        request: buildDraftRequest('Capital of France?', 'claude-sonnet-5'),
        response: { id: 'msg_02', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_02', name: 'report_draft', input: { answer: 'Paris', confidence: 0.95 } }] },
      },
    };
    assert.deepEqual(failed(verifyProvenance(commit({ tier: 'instant', submissions: [], result, action: 'resolve' }))), []);
  });

  test('no answers -> refund verifies; the same record claiming "resolve" fails the decision check', () => {
    const result = { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' };
    assert.deepEqual(failed(verifyProvenance(commit({ submissions: [], result, action: 'refund' }))), []);
    assert.ok(failed(verifyProvenance(commit({ submissions: [], result, action: 'resolve' }))).some((n) => n.startsWith('decision')));
  });

  test('below-MIN_CONFIDENCE plurality must be a refund', () => {
    const submissions = [W('w1', 'A'), W('w2', 'B'), W('w3', 'C')];
    const result = { consensus: 'A', confidence: 1 / 3, matchingWorkerIds: ['w1'], method: 'exact-match-fallback', llmError: 'x' };
    assert.deepEqual(failed(verifyProvenance(commit({ submissions, result, action: 'refund' }))), []);
    assert.ok(failed(verifyProvenance(commit({ submissions, result, action: 'resolve' }))).some((n) => n.startsWith('decision')));
  });
});

describe('verifyProvenance: tamper evidence', () => {
  const submissions = [W('w1', 'Paris'), W('w2', 'Paris'), W('w3', 'Paris')];
  const base = () => commit({ submissions, result: { consensus: 'Paris', confidence: 1, matchingWorkerIds: ['w1', 'w2', 'w3'], method: 'exact-match-fastpath' }, action: 'resolve' });

  test('editing any committed field without re-hashing breaks the hash check', () => {
    const entry = base();
    entry.record.submissions[2].answer = 'Lyon';
    assert.ok(failed(verifyProvenance(entry)).includes('record hash recomputes to the committed hash'));
  });

  test('editing and re-hashing is caught by comparing against the independently published hash', () => {
    const original = base();
    const forged = structuredClone(original);
    forged.record.submissions[2].answer = 'Lyon';
    forged.hash = hashRecord(forged.record);
    const result = verifyProvenance(forged, { expectedHash: original.hash });
    assert.ok(failed(result).includes('committed hash matches the independently published hash'));
    // ...and the forged inputs no longer re-derive the committed result either.
    assert.ok(failed(result).includes('consensus matches a fresh exact-match vote') || failed(result).some((n) => n.startsWith('fast path')));
  });
});

describe('storage', () => {
  test('save -> get -> attachSettlement keeps the committed hash and adds settlement outside it', async () => {
    const { record } = commit({ questionId: 'prov-store-1', submissions: [], result: { consensus: null, confidence: 0, matchingWorkerIds: [], method: 'no-answers' }, action: 'refund' });
    const hash = await saveProvenance('prov-store-1', record);
    await attachSettlement('prov-store-1', { outcome: 'refunded', payoutTx: null, refundTx: 'abc' });
    const entry = await getProvenance('prov-store-1');
    assert.equal(entry.hash, hash);
    assert.equal(entry.settlement.refundTx, 'abc');
    assert.equal(hashRecord(entry.record), hash);
  });
});

describe('on-chain settlement decoding', () => {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const [w1, w2, w3] = [Keypair.random(), Keypair.random(), Keypair.random()].map((k) => k.publicKey());
  const admin = Keypair.random();

  function resolveTx(questionId, winners, losers) {
    const vec = (xs) => nativeToScVal(xs.map((a) => new Address(a)), { type: 'Vec' });
    return new TransactionBuilder(new Account(admin.publicKey(), '1'), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(contractId).call('resolve', nativeToScVal(BigInt(questionId), { type: 'u64' }), vec(winners), vec(losers)))
      .setTimeout(60)
      .build();
  }

  const submissions = [W(w1, 'Paris'), W(w2, 'Paris'), W(w3, 'Lyon')];
  const { record } = commit({ submissions, result: { consensus: 'Paris', confidence: 2 / 3, matchingWorkerIds: [w1, w2], method: 'exact-match-fallback', llmError: 'x' }, action: 'resolve' });

  test('decodes a real resolve() envelope and confirms it paid exactly the matching workers', () => {
    const call = extractContractCall(resolveTx(42, [w1, w2], [w3]).toEnvelope().toXDR('base64'));
    assert.deepEqual(call, { contractId, functionName: 'resolve', questionId: '42', workers: [w1, w2], losingWorkers: [w3] });
    assert.deepEqual(failed(verifyPayout(record, call)), []);
  });

  test('unwraps a fee-bumped envelope', () => {
    const inner = resolveTx(42, [w1, w2], [w3]);
    inner.sign(admin);
    const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '200', inner, PASSPHRASE);
    assert.equal(extractContractCall(bump.toEnvelope().toXDR('base64')).questionId, '42');
  });

  test('an on-chain payout to a different worker set than the record fails', () => {
    const call = extractContractCall(resolveTx(42, [w1, w3], [w2]).toEnvelope().toXDR('base64'));
    assert.ok(failed(verifyPayout(record, call)).includes('credited workers are exactly the matching workers'));
  });

  test('a resolve() for a different question id fails', () => {
    const call = extractContractCall(resolveTx(43, [w1, w2], [w3]).toEnvelope().toXDR('base64'));
    assert.ok(failed(verifyPayout(record, call)).includes('on-chain question id matches'));
  });
});

describe('scripts/verify-provenance.js', () => {
  function run(args) {
    return new Promise((resolve) => {
      execFile('node', ['scripts/verify-provenance.js', ...args], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, out: stdout + stderr });
      });
    });
  }

  test('exits 0 for an intact record and 1 once any answer is edited', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prov-'));
    const entry = commit({ submissions: [W('w1', 'Paris'), W('w2', 'Paris')], result: { consensus: 'Paris', confidence: 1, matchingWorkerIds: ['w1', 'w2'], method: 'exact-match-fastpath' }, action: 'resolve' });
    const good = path.join(dir, 'good.json');
    await writeFile(good, JSON.stringify({ ...entry, settlement: null }));
    const ok = await run(['--file', good, '--expected-hash', entry.hash]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /VERIFIED/);

    entry.record.submissions[1].answer = 'Lyon';
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ ...entry, settlement: null }));
    const tampered = await run(['--file', bad]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.out, /✗ record hash recomputes/);
  });

  test('exits 2 with usage on missing arguments', async () => {
    const { code, out } = await run([]);
    assert.equal(code, 2);
    assert.match(out, /usage:/);
  });
});

describe('oracle fulfillment integration (no chain configured)', () => {
  test('a real dispatch -> reconcile -> settle run commits provenance before settling and publishes the hash on the job', async () => {
    const { registerWorker, unregisterWorker, submitAnswer } = await import('../src/dispatch.js');
    const { startFulfillment } = await import('../src/oracle.js');
    const { getJob } = await import('../src/jobs.js');

    // Two fake SSE workers that answer the moment a question is broadcast.
    const answering = (workerId, answer) => ({
      write(chunk) {
        const match = /^event: question\ndata: (.*)\n/m.exec(chunk);
        if (match) setImmediate(() => submitAnswer(JSON.parse(match[1]).questionId, workerId, answer));
      },
    });
    registerWorker('prov-int-w1', answering('prov-int-w1', 'Paris'), []);
    registerWorker('prov-int-w2', answering('prov-int-w2', 'paris'), []);

    const questionId = `prov-int-${Date.now()}`;
    const tier = { key: 'standard', quorumSize: 2, timeoutMs: 5_000, priceStroops: 1_000_000n };
    try {
      await startFulfillment(questionId, { question: 'Capital of France?' }, tier, null);
      let job;
      for (let i = 0; i < 200 && job?.status !== 'settled'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = await getJob(questionId);
      }
      assert.equal(job.status, 'settled');
      assert.match(job.provenanceHash, /^[0-9a-f]{64}$/);

      const entry = await getProvenance(questionId);
      assert.equal(entry.hash, job.provenanceHash);
      assert.deepEqual(entry.record.submissions.map((s) => s.workerId).sort(), ['prov-int-w1', 'prov-int-w2']);
      // Fresh test workers, so no fast path; no API key, so the vote fallback.
      assert.equal(entry.record.reconciliation.method, 'exact-match-fallback');
      assert.equal(entry.record.decision.action, 'resolve');
      // No PLATFORM_SECRET here, so resolve() and refund() both fail and the
      // job falls back to the payer's refund_timeout() path — provenance
      // still records the decision that was made, plus what really happened.
      assert.equal(entry.settlement.outcome, job.outcome);
      assert.deepEqual(failed(verifyProvenance(entry, { expectedHash: job.provenanceHash })), []);
    } finally {
      unregisterWorker('prov-int-w1');
      unregisterWorker('prov-int-w2');
    }
  });
});

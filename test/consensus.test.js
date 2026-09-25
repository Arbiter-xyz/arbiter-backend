import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConsensusRule,
  parseNumericAnswer,
  withinTolerance,
  largestToleranceCluster,
  numericToleranceVote,
} from '../src/consensus.js';
import { reconcile, groupByNormalizedAnswer } from '../src/reconcile.js';
import { startFulfillment, getJobStatus, issueChallenge, consensusRuleFromPending } from '../src/oracle.js';
import { getStashedQuestion, nextQuestionId } from '../src/pendingQuestions.js';
import { registerWorker, unregisterWorker, submitAnswer } from '../src/dispatch.js';

const established = (workerId, answer) => ({ workerId, answer, established: true });
const fresh = (workerId, answer) => ({ workerId, answer, established: false });

// --- parseConsensusRule: input validation ---

test('no consensusMode, or an explicit "exact", is the default rule (null)', () => {
  assert.deepEqual(parseConsensusRule({}), { ok: true, rule: null });
  assert.deepEqual(parseConsensusRule(), { ok: true, rule: null });
  assert.deepEqual(parseConsensusRule({ consensusMode: 'exact' }), { ok: true, rule: null });
});

test('numeric-tolerance accepts a percent or an absolute tolerance', () => {
  assert.deepEqual(parseConsensusRule({ consensusMode: 'numeric-tolerance', tolerance: { percent: 5 } }), {
    ok: true,
    rule: { mode: 'numeric-tolerance', tolerance: { percent: 5 } },
  });
  assert.deepEqual(parseConsensusRule({ consensusMode: 'numeric-tolerance', tolerance: { absolute: 0.5 } }), {
    ok: true,
    rule: { mode: 'numeric-tolerance', tolerance: { absolute: 0.5 } },
  });
});

test('numeric-tolerance without a tolerance defaults to numeric equality', () => {
  assert.deepEqual(parseConsensusRule({ consensusMode: 'numeric-tolerance' }).rule.tolerance, { absolute: 0 });
});

test('invalid modes and tolerances are rejected with a message', () => {
  const bad = [
    { consensusMode: 'majority' },
    { consensusMode: 42 },
    { consensusMode: 'numeric-tolerance', tolerance: 5 },
    { consensusMode: 'numeric-tolerance', tolerance: [5] },
    { consensusMode: 'numeric-tolerance', tolerance: {} },
    { consensusMode: 'numeric-tolerance', tolerance: { percent: 5, absolute: 1 } },
    { consensusMode: 'numeric-tolerance', tolerance: { relative: 5 } },
    { consensusMode: 'numeric-tolerance', tolerance: { percent: -1 } },
    { consensusMode: 'numeric-tolerance', tolerance: { percent: 101 } },
    { consensusMode: 'numeric-tolerance', tolerance: { absolute: '1' } },
    { consensusMode: 'numeric-tolerance', tolerance: { absolute: Infinity } },
    { tolerance: { percent: 5 } }, // tolerance without the numeric mode
  ];
  for (const input of bad) {
    const result = parseConsensusRule(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(typeof result.error, 'string');
  }
});

// --- parseNumericAnswer ---

test('parseNumericAnswer handles plain, signed, decimal and exponent numbers', () => {
  assert.equal(parseNumericAnswer('42'), 42);
  assert.equal(parseNumericAnswer(' 42.0 '), 42);
  assert.equal(parseNumericAnswer('-3.5'), -3.5);
  assert.equal(parseNumericAnswer('+7'), 7);
  assert.equal(parseNumericAnswer('.5'), 0.5);
  assert.equal(parseNumericAnswer('1e3'), 1000);
  assert.equal(parseNumericAnswer('42.'), 42);
});

test('parseNumericAnswer handles currency, percent, thousands separators, and approximation words', () => {
  assert.equal(parseNumericAnswer('$42'), 42);
  assert.equal(parseNumericAnswer('€1,234.50'), 1234.5);
  assert.equal(parseNumericAnswer('-$5'), -5);
  assert.equal(parseNumericAnswer('42%'), 42);
  assert.equal(parseNumericAnswer('1,000,000'), 1_000_000);
  assert.equal(parseNumericAnswer('about 42'), 42);
  assert.equal(parseNumericAnswer('Approximately 42'), 42);
  assert.equal(parseNumericAnswer('~42'), 42);
});

test('parseNumericAnswer returns null for non-numbers and ambiguous formats', () => {
  for (const text of ['Paris', '', '   ', '42 apples', 'forty-two', '3,5', '1,23,456', '12-15', '$', '%', 'NaN', 'Infinity', null, undefined]) {
    assert.equal(parseNumericAnswer(text), null, String(text));
  }
});

// --- tolerance and clustering ---

test('withinTolerance: absolute and percent', () => {
  assert.equal(withinTolerance(42.4, 42, { absolute: 0.5 }), true);
  assert.equal(withinTolerance(42.6, 42, { absolute: 0.5 }), false);
  assert.equal(withinTolerance(105, 100, { percent: 5 }), true);
  assert.equal(withinTolerance(106, 100, { percent: 5 }), false);
  assert.equal(withinTolerance(0, 0, { percent: 5 }), true);
  assert.equal(withinTolerance(0.1, 0, { percent: 5 }), false);
});

test('largestToleranceCluster picks the center gathering the most members (tolerance is not transitive)', () => {
  const entries = [1, 2, 3].map((value, i) => ({ workerId: `w${i}`, answer: String(value), value }));
  const cluster = largestToleranceCluster(entries, { absolute: 1 });
  assert.equal(cluster.center.value, 2); // 1 and 3 each only reach 2, but 2 reaches both
  assert.deepEqual(cluster.members.map((e) => e.workerId), ['w0', 'w1', 'w2']);
});

test('largestToleranceCluster breaks ties by tighter spread, then by order', () => {
  const entries = [10, 11, 20].map((value, i) => ({ workerId: `w${i}`, answer: String(value), value }));
  assert.equal(largestToleranceCluster(entries, { absolute: 1 }).center.value, 10);
  assert.equal(largestToleranceCluster([], { absolute: 1 }), null);
});

// --- numericToleranceVote ---

test('numericToleranceVote matches near-identical numeric answers within tolerance', () => {
  const vote = numericToleranceVote(
    [established('w1', '42'), established('w2', '42.0'), established('w3', 'about 42'), established('w4', '$42.3')],
    { absolute: 0.5 },
    groupByNormalizedAnswer,
  );
  assert.equal(vote.allAgree, true);
  assert.equal(vote.confidence, 1);
  assert.deepEqual(vote.matchingWorkerIds, ['w1', 'w2', 'w3', 'w4']);
  assert.equal(vote.consensus, '42');
});

test('numericToleranceVote leaves answers outside tolerance out of the winning group', () => {
  const vote = numericToleranceVote(
    [established('w1', '100'), established('w2', '102'), established('w3', '120')],
    { percent: 5 },
    groupByNormalizedAnswer,
  );
  assert.equal(vote.allAgree, false);
  assert.deepEqual(vote.matchingWorkerIds, ['w1', 'w2']);
  assert.ok(Math.abs(vote.confidence - 2 / 3) < 1e-9);
});

test('numericToleranceVote groups non-numeric answers by the exact-match string path, against all submissions', () => {
  const vote = numericToleranceVote(
    [established('w1', 'unknown'), established('w2', 'Unknown.'), established('w3', 'UNKNOWN'), established('w4', '42')],
    { absolute: 1 },
    groupByNormalizedAnswer,
  );
  assert.deepEqual(vote.matchingWorkerIds, ['w1', 'w2', 'w3']);
  assert.equal(vote.confidence, 3 / 4);
  assert.equal(vote.consensus, 'unknown');
});

test('numericToleranceVote prefers the numeric cluster on a tie with a string group', () => {
  const vote = numericToleranceVote(
    [established('w1', 'n/a'), established('w2', '7'), established('w3', 'n/a'), established('w4', '7.1')],
    { absolute: 0.5 },
    groupByNormalizedAnswer,
  );
  assert.deepEqual(vote.matchingWorkerIds, ['w2', 'w4']);
});

// --- reconcile() with consensusMode: 'numeric-tolerance' ---

const numericRule = (tolerance) => ({ mode: 'numeric-tolerance', tolerance });

test('reconcile: established workers all within tolerance take the numeric fast path', async () => {
  const result = await reconcile(
    'How many?',
    [established('w1', '42'), established('w2', '42.0'), established('w3', '~42')],
    'q',
    numericRule({ absolute: 0 }),
  );
  assert.equal(result.method, 'numeric-tolerance-fastpath');
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.matchingWorkerIds.sort(), ['w1', 'w2', 'w3']);
});

test('reconcile: the same answers in the default mode do NOT agree (they are different strings)', async () => {
  const result = await reconcile('How many?', [established('w1', '42'), established('w2', '42.0'), established('w3', '~42')], 'q');
  assert.equal(result.method, 'exact-match-fallback');
  assert.ok(result.confidence < 1);
});

test('reconcile: unanimous-within-tolerance but with a fresh worker skips the fast path', async () => {
  const result = await reconcile(
    'How many?',
    [established('w1', '42'), fresh('w2', '42.0')],
    'q',
    numericRule({ absolute: 0 }),
  );
  assert.notEqual(result.method, 'numeric-tolerance-fastpath');
  // No ANTHROPIC_API_KEY in tests, so Claude falls back to the numeric vote.
  assert.equal(result.method, 'numeric-tolerance-fallback');
  assert.equal(result.confidence, 1);
});

test('reconcile: disagreement outside tolerance falls back to the numeric plurality', async () => {
  const result = await reconcile(
    'Price?',
    [established('w1', '$10'), established('w2', '10.2'), established('w3', '$15')],
    'q',
    numericRule({ percent: 5 }),
  );
  assert.equal(result.method, 'numeric-tolerance-fallback');
  assert.deepEqual(result.matchingWorkerIds.sort(), ['w1', 'w2']);
  assert.ok(Math.abs(result.confidence - 2 / 3) < 1e-9);
});

test('reconcile: mixed numeric and non-numeric submissions', async () => {
  const result = await reconcile(
    'Population?',
    [established('w1', '1,000'), established('w2', '1000'), established('w3', 'no idea')],
    'q',
    numericRule({ absolute: 0 }),
  );
  assert.equal(result.method, 'numeric-tolerance-fallback');
  assert.deepEqual(result.matchingWorkerIds.sort(), ['w1', 'w2']);
});

test('reconcile: no submissions is still the no-answers path in numeric mode', async () => {
  const result = await reconcile('Q?', [], 'q', numericRule({ absolute: 1 }));
  assert.equal(result.method, 'no-answers');
});

// --- plumbing: stash -> pending -> reconcile -> job record ---

test('issueChallenge stashes a non-default rule and echoes it; the default leaves the stash untouched', async () => {
  const rule = numericRule({ percent: 2 });
  const challenge = await issueChallenge('How many?', 'standard', null, rule);
  assert.equal(challenge.consensusMode, 'numeric-tolerance');
  assert.deepEqual(challenge.consensusTolerance, { percent: 2 });
  const stashed = await getStashedQuestion(challenge.questionId);
  assert.deepEqual(consensusRuleFromPending(stashed), rule);

  const plain = await issueChallenge('How many?', 'standard', null);
  assert.equal('consensusMode' in plain, false);
  const plainStash = await getStashedQuestion(plain.questionId);
  assert.equal('consensusMode' in plainStash, false);
  assert.equal(consensusRuleFromPending(plainStash), null);
});

async function waitForSettled(jobId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJobStatus(jobId);
    if (job?.status === 'settled') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not settle in time`);
}

test('a numeric-tolerance question reconciles with its rule, and the settled job shows the rule applied', async () => {
  const tier = { key: 'standard', quorumSize: 2, timeoutMs: 2000, priceStroops: 1n };
  const questionId = (await nextQuestionId()).toString();
  const pending = { question: 'How many?', category: null, consensusMode: 'numeric-tolerance', consensusTolerance: { absolute: 0.5 } };
  const res = { write() {} };
  registerWorker('consensus-w1', res, []);
  registerWorker('consensus-w2', res, []);
  try {
    await startFulfillment(questionId, pending, tier, null);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(submitAnswer(questionId, 'consensus-w1', '42'), true);
    assert.equal(submitAnswer(questionId, 'consensus-w2', 'about 42.2'), true);

    const job = await waitForSettled(questionId);
    assert.equal(job.consensusMode, 'numeric-tolerance');
    assert.deepEqual(job.consensusTolerance, { absolute: 0.5 });
    assert.equal(job.reconciliationMethod, 'numeric-tolerance-fallback');
    assert.equal(job.confidence, 1);
  } finally {
    unregisterWorker('consensus-w1');
    unregisterWorker('consensus-w2');
  }
});

test('a default question records consensusMode "exact" and no tolerance on its job', async () => {
  const tier = { key: 'standard', quorumSize: 1, timeoutMs: 100, priceStroops: 1n };
  const questionId = (await nextQuestionId()).toString();
  await startFulfillment(questionId, { question: 'Q?', category: null }, tier, null);
  const job = await waitForSettled(questionId);
  assert.equal(job.consensusMode, 'exact');
  assert.equal('consensusTolerance' in job, false);
});

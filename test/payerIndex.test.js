import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPayerQuestion, getPayerQuestionIds, summarizePayerQuestions } from '../src/payerIndex.js';

test('a fresh payer address has no tracked questions', async () => {
  const ids = await getPayerQuestionIds(`GFRESH${Date.now()}`);
  assert.deepEqual(ids, []);
});

test('recorded questions are returned newest-first', async () => {
  const payer = `GPAYER${Date.now()}`;
  await recordPayerQuestion(payer, 'q1');
  await recordPayerQuestion(payer, 'q2');
  await recordPayerQuestion(payer, 'q3');

  const ids = await getPayerQuestionIds(payer);
  assert.deepEqual(ids, ['q3', 'q2', 'q1']);
});

test('recording the same questionId twice does not duplicate it', async () => {
  const payer = `GDUPE${Date.now()}`;
  await recordPayerQuestion(payer, 'q1');
  await recordPayerQuestion(payer, 'q2');
  await recordPayerQuestion(payer, 'q1'); // re-verify same question, e.g. a client retry

  const ids = await getPayerQuestionIds(payer);
  assert.deepEqual(ids, ['q1', 'q2']);
});

test('different payer addresses have fully independent histories', async () => {
  const payerA = `GALPHA${Date.now()}`;
  const payerB = `GBETA${Date.now()}`;
  await recordPayerQuestion(payerA, 'a1');
  await recordPayerQuestion(payerB, 'b1');

  assert.deepEqual(await getPayerQuestionIds(payerA), ['a1']);
  assert.deepEqual(await getPayerQuestionIds(payerB), ['b1']);
});

test('summarizePayerQuestions computes spend and success rate from settled jobs, ignoring expired (null) entries', () => {
  const ids = ['q1', 'q2', 'q3', 'q4-expired'];
  const jobs = [
    { status: 'settled', outcome: 'resolved', amountStroops: '2500000' },
    { status: 'settled', outcome: 'refunded', amountStroops: '2500000' },
    { status: 'awaiting_workers', amountStroops: '4000000' },
    null, // expired job record — filtered out
  ];

  const summary = summarizePayerQuestions(ids, jobs);

  assert.equal(summary.totalTracked, 4);
  assert.equal(summary.questions.length, 3); // the null/expired one is dropped
  assert.equal(summary.totalSpendStroops, 9_000_000n); // 2.5m + 2.5m + 4m, expired excluded
  assert.equal(summary.settled, 2); // only q1/q2 are settled; q3 is still in flight
  assert.equal(summary.resolved, 1);
  assert.equal(summary.successRate, 0.5);
});

test('summarizePayerQuestions returns a null success rate when nothing has settled yet', () => {
  const summary = summarizePayerQuestions(['q1'], [{ status: 'awaiting_workers', amountStroops: '2500000' }]);
  assert.equal(summary.successRate, null);
  assert.equal(summary.totalSpendStroops, 2_500_000n);
});

test('summarizePayerQuestions on an empty history returns zeroed, non-throwing output', () => {
  const summary = summarizePayerQuestions([], []);
  assert.deepEqual(summary.questions, []);
  assert.equal(summary.totalTracked, 0);
  assert.equal(summary.totalSpendStroops, 0n);
  assert.equal(summary.successRate, null);
});

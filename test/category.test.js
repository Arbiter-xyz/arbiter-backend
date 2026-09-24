import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, updateJob, getJob } from '../src/jobs.js';
import { startFulfillment } from '../src/oracle.js';
import { resolveTier } from '../src/pricing.js';
import { listTransactions } from '../src/admin.js';
import { recordPayerQuestion, getPayerQuestionIds, summarizePayerQuestions, bucketPayerSpend } from '../src/payerIndex.js';

// #48 — question category persisted on job records, plus per-category and
// per-day spend buckets for GET /payers/:address/questions.

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Real question ids are numeric (u64 on-chain); the background settle path
// converts them with BigInt(), so fulfillment tests use numeric ids too.
function numericId() {
  return String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

test('category round-trips through createJob, updateJob and getJob', async () => {
  const jobId = uniqueId('q');
  await createJob(jobId, { amountStroops: '2500000', category: 'geography' });
  await updateJob(jobId, { status: 'reconciling' });
  await updateJob(jobId, { status: 'settled', outcome: 'resolved' });

  const job = await getJob(jobId);
  assert.equal(job.category, 'geography');
  assert.equal(job.status, 'settled');
});

test('startFulfillment persists the stashed category on the job record', async () => {
  const jobId = numericId();
  const tier = { ...resolveTier('standard') };
  // quorumSize > 0 with no workers online: the job is created synchronously,
  // then dispatch waits in the background, which this test doesn't need.
  await startFulfillment(jobId, { question: 'Is it raining in Lagos?', category: 'weather' }, { ...tier, timeoutMs: 1 }, null);
  const job = await getJob(jobId);
  assert.equal(job.category, 'weather');
});

test('a question asked without a category is stored as null, not omitted', async () => {
  const jobId = numericId();
  await startFulfillment(jobId, { question: 'q?' }, { ...resolveTier('standard'), timeoutMs: 1 }, null);
  const job = await getJob(jobId);
  assert.ok('category' in job);
  assert.equal(job.category, null);
});

test('GET /admin/transactions rows (listTransactions) include category with no extra wiring', async () => {
  const jobId = uniqueId('q');
  await createJob(jobId, { amountStroops: '1000000', payer: 'GPAYER', category: 'sports' });
  const { transactions } = await listTransactions({ limit: 200 });
  assert.equal(transactions.find((t) => t.questionId === jobId).category, 'sports');
});

test('payer question summaries carry category through to bucketing', async () => {
  const payer = `GCAT${Date.now()}`;
  const ids = [uniqueId('q'), uniqueId('q')];
  await createJob(ids[0], { status: 'settled', outcome: 'resolved', amountStroops: '2500000', category: 'Sports' });
  await createJob(ids[1], { status: 'settled', outcome: 'refunded', amountStroops: '4000000', category: 'weather' });
  for (const id of ids) await recordPayerQuestion(payer, id);

  const tracked = await getPayerQuestionIds(payer);
  const summary = summarizePayerQuestions(tracked, await Promise.all(tracked.map((id) => getJob(id))));
  const { spendByCategory } = bucketPayerSpend(summary.questions);
  assert.deepEqual(
    spendByCategory.map((b) => [b.category, b.spendStroops]),
    [
      ['weather', '4000000'],
      ['sports', '2500000'],
    ],
  );
});

test('bucketPayerSpend groups by normalized category and UTC day', () => {
  const day1 = Date.UTC(2026, 8, 20, 23, 30); // 2026-09-20 late evening UTC
  const day2 = Date.UTC(2026, 8, 21, 0, 15); // just after midnight UTC
  const questions = [
    { category: 'Weather', amountStroops: '2500000', createdAt: day1, outcome: 'resolved' },
    { category: ' weather ', amountStroops: '2500000', createdAt: day2, outcome: 'refunded' },
    { category: 'sports', amountStroops: '10000000', createdAt: day2, outcome: 'resolved' },
    { category: null, amountStroops: '500000', createdAt: day2 },
    { amountStroops: '500000', createdAt: day1 }, // pre-#48 record, no category field at all
  ];

  const { spendByCategory, spendByDay } = bucketPayerSpend(questions);

  assert.deepEqual(spendByCategory, [
    { category: 'sports', questions: 1, resolved: 1, spendStroops: '10000000', spend: '1.0000000' },
    { category: 'weather', questions: 2, resolved: 1, spendStroops: '5000000', spend: '0.5000000' },
    { category: null, questions: 2, resolved: 0, spendStroops: '1000000', spend: '0.1000000' },
  ]);
  assert.deepEqual(spendByDay, [
    { day: '2026-09-20', questions: 2, resolved: 1, spendStroops: '3000000', spend: '0.3000000' },
    { day: '2026-09-21', questions: 3, resolved: 1, spendStroops: '13000000', spend: '1.3000000' },
  ]);
});

test('bucketPayerSpend on an empty history returns empty arrays', () => {
  assert.deepEqual(bucketPayerSpend([]), { spendByCategory: [], spendByDay: [] });
});

test('bucketPayerSpend output is JSON-serializable (no BigInt leaks)', () => {
  const out = bucketPayerSpend([{ category: 'x', amountStroops: '1', createdAt: Date.now() }]);
  assert.doesNotThrow(() => JSON.stringify(out));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJob,
  getJob,
  updateJob,
  markPendingReview,
  approveReview,
  escalateItem,
  unescalateItem,
  getEscalatedItems,
  getPendingReviewJobIds,
} from '../src/jobs.js';

// #254 — review-queue functions: markPendingReview, approveReview,
// escalateItem, unescalateItem. Each gets a success path and a realistic
// failure/edge case.

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('markPendingReview moves a job into the review queue and indexes it', async () => {
  const jobId = uniqueId('review');
  await createJob(jobId, { questionId: '42' });

  const moved = await markPendingReview(jobId, { reviewReason: 'low_confidence' });

  assert.equal(moved, true);
  const job = await getJob(jobId);
  assert.equal(job.status, 'pending_review');
  assert.equal(job.questionId, '42');
  assert.equal(job.reviewReason, 'low_confidence');
  assert.ok(job.reviewRequestedAt);
  assert.ok((await getPendingReviewJobIds()).includes(jobId));
});

test('markPendingReview returns false for an already-settled job and leaves it untouched', async () => {
  const jobId = uniqueId('review');
  await createJob(jobId, {});
  await updateJob(jobId, { status: 'settled', outcome: 'resolved' });

  const moved = await markPendingReview(jobId);

  assert.equal(moved, false);
  const job = await getJob(jobId);
  assert.equal(job.status, 'settled');
  assert.equal(job.outcome, 'resolved');
  assert.ok(!(await getPendingReviewJobIds()).includes(jobId));
});

test('markPendingReview is idempotent for a job already pending review', async () => {
  const jobId = uniqueId('review');
  await createJob(jobId, {});
  assert.equal(await markPendingReview(jobId), true);

  assert.equal(await markPendingReview(jobId), false);
});

test('approveReview settles a pending job and clears its queue/escalation entries', async () => {
  const jobId = uniqueId('review');
  await createJob(jobId, { questionId: '7' });
  await markPendingReview(jobId);
  await escalateItem('review', jobId);

  const settled = await approveReview(jobId, 'resolved', async (job, outcome) => {
    assert.equal(job.questionId, '7');
    return updateJob(jobId, { status: 'settled', outcome });
  });

  assert.equal(settled.status, 'settled');
  assert.equal(settled.outcome, 'resolved');
  assert.ok(!(await getPendingReviewJobIds()).includes(jobId));
  assert.ok(!(await getEscalatedItems()).some((e) => e.kind === 'review' && e.id === jobId));
});

test('approveReview returns null and does not settle a job that is not pending review', async () => {
  const jobId = uniqueId('review');
  await createJob(jobId, {});
  let settleCalls = 0;

  const result = await approveReview(jobId, 'resolved', async () => {
    settleCalls += 1;
    return updateJob(jobId, { status: 'settled', outcome: 'resolved' });
  });

  assert.equal(result, null);
  assert.equal(settleCalls, 0);
  assert.equal((await getJob(jobId)).status, 'awaiting_workers');
});

test('approveReview returns null for an unknown jobId', async () => {
  const result = await approveReview(uniqueId('missing'), 'resolved', async () => {
    throw new Error('settle must not be called for an unknown job');
  });
  assert.equal(result, null);
});

test('escalateItem records an item once and is idempotent', async () => {
  const id = uniqueId('item');

  assert.equal(await escalateItem('review', id), true);
  assert.equal(await escalateItem('review', id), false);

  const entries = (await getEscalatedItems()).filter((e) => e.id === id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'review');
  assert.ok(entries[0].escalatedAt);
});

test('escalateItem treats the same id under a different kind as a separate item', async () => {
  const id = uniqueId('item');

  assert.equal(await escalateItem('review', id), true);
  assert.equal(await escalateItem('dispute', id), true);

  const kinds = (await getEscalatedItems())
    .filter((e) => e.id === id)
    .map((e) => e.kind)
    .sort();
  assert.deepEqual(kinds, ['dispute', 'review']);
});

test('unescalateItem clears an escalated item', async () => {
  const id = uniqueId('item');
  await escalateItem('review', id);

  assert.equal(await unescalateItem('review', id), true);
  assert.ok(!(await getEscalatedItems()).some((e) => e.id === id));
});

test('unescalateItem returns false for an item that was never escalated', async () => {
  assert.equal(await unescalateItem('review', uniqueId('never')), false);
});

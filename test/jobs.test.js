import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJob,
  updateJob,
  getJob,
  markPendingReview,
  getPendingReviewJobIds,
  getPendingReviews,
  approveReview,
  escalateItem,
  unescalateItem,
  getEscalatedItems,
  getEscalatedIds,
} from '../src/jobs.js';

function uniqueJobId(prefix = 'review-job') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('manual review queue (#243, #254)', () => {
  test('markPendingReview transitions an active job to pending_review, indexes it, and preserves extra metadata', async () => {
    const jobId = uniqueJobId('pending');
    await createJob(jobId, { questionId: jobId, question: 'Needs review?' });

    const transitioned = await markPendingReview(jobId, {
      confidence: 0.45,
      proposedAnswer: 'Maybe',
      reviewReason: 'low-confidence',
    });
    assert.equal(transitioned, true);

    const job = await getJob(jobId);
    assert.equal(job.status, 'pending_review');
    assert.equal(job.confidence, 0.45);
    assert.equal(job.proposedAnswer, 'Maybe');
    assert.equal(typeof job.reviewRequestedAt, 'number');

    const ids = await getPendingReviewJobIds();
    assert.ok(ids.includes(jobId));

    const reviews = await getPendingReviews();
    assert.ok(reviews.some((r) => r.questionId === jobId));
  });

  test('markPendingReview is idempotent and refuses already-queued or terminal jobs', async () => {
    const queuedId = uniqueJobId('already-queued');
    await createJob(queuedId, { questionId: queuedId });
    assert.equal(await markPendingReview(queuedId), true);
    assert.equal(await markPendingReview(queuedId), false, 'second call on pending_review job must return false');

    const settledId = uniqueJobId('already-settled');
    await createJob(settledId, { questionId: settledId });
    await updateJob(settledId, { status: 'settled', outcome: 'resolved' });
    assert.equal(await markPendingReview(settledId), false, 'settled job must not enter pending_review');
  });

  test('approveReview settles a pending_review job, unindexes it, and clears any escalation flag', async () => {
    const jobId = uniqueJobId('approve');
    await createJob(jobId, { questionId: jobId, question: 'Approve me?' });
    await markPendingReview(jobId, { confidence: 0.5 });
    await escalateItem('review', jobId);
    assert.equal((await getEscalatedIds('review')).has(jobId), true);

    const settled = await approveReview(jobId, 'resolved', async (job, outcome) => {
      return updateJob(job.questionId, { status: 'settled', outcome, answer: 'Approved answer' });
    });

    assert.ok(settled);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.outcome, 'resolved');
    assert.equal((await getPendingReviewJobIds()).includes(jobId), false);
    assert.equal((await getEscalatedIds('review')).has(jobId), false);
  });

  test('approveReview returns null for non-existent or non-pending_review jobs and rejects invalid outcomes', async () => {
    assert.equal(await approveReview('non-existent-job-id', 'resolved', async () => ({})), null);

    const jobId = uniqueJobId('not-in-review');
    await createJob(jobId, { questionId: jobId });
    assert.equal(await approveReview(jobId, 'resolved', async () => ({})), null);

    await markPendingReview(jobId);
    await assert.rejects(
      () => approveReview(jobId, 'bogus-outcome', async () => ({})),
      /invalid review outcome/,
    );
  });
});

describe('escalation queue (#254)', () => {
  test('escalateItem and unescalateItem are idempotent and scope membership by kind', async () => {
    const id = uniqueJobId('esc');

    assert.equal(await escalateItem('review', id), true, 'first escalation returns true');
    assert.equal(await escalateItem('review', id), false, 'duplicate escalation returns false');

    // Different kind ('dispute') with the same id is tracked independently
    assert.equal(await escalateItem('dispute', id), true);

    const reviewSet = await getEscalatedIds('review');
    const disputeSet = await getEscalatedIds('dispute');
    assert.equal(reviewSet.has(id), true);
    assert.equal(disputeSet.has(id), true);

    const all = await getEscalatedItems();
    assert.ok(all.some((e) => e.kind === 'review' && e.id === id && typeof e.escalatedAt === 'number'));

    assert.equal(await unescalateItem('review', id), true, 'removing existing escalation returns true');
    assert.equal(await unescalateItem('review', id), false, 'removing already-cleared escalation returns false');
    assert.equal((await getEscalatedIds('review')).has(id), false);
    assert.equal((await getEscalatedIds('dispute')).has(id), true);

    await unescalateItem('dispute', id);
  });
});

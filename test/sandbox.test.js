import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSandboxChallenge, startSandboxFulfillment } from '../src/sandbox.js';
import { getJob } from '../src/jobs.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSettled(jobId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(jobId);
    if (job && job.status === 'settled') return job;
    await sleep(50);
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

test('issueSandboxChallenge returns a fully-shaped, zero-cost challenge', () => {
  const challenge = issueSandboxChallenge('sandbox-1', 'What is 2+2?', 'standard');
  assert.equal(challenge.sandbox, true);
  assert.equal(challenge.amount, '0.00');
  assert.equal(challenge.amountStroops, '0');
  assert.equal(challenge.quorumSize, 3);
  assert.equal(challenge.question, 'What is 2+2?');
});

test('default simulate mode ("resolved") settles as resolved with a fake, clearly-labeled payout tx', async () => {
  const jobId = 'sandbox-resolved-1';
  await startSandboxFulfillment(jobId, 'What is the capital of France?', {});
  const job = await waitForSettled(jobId);

  assert.equal(job.sandbox, true);
  assert.equal(job.outcome, 'resolved');
  assert.equal(job.confidence, 1);
  assert.match(job.payoutTx, /^SANDBOX-payout-/);
  assert.equal(job.matchingWorkers.length, 3);
});

test('simulate=disagreement settles as refunded with low confidence, no real Claude call needed', async () => {
  const jobId = 'sandbox-disagreement-1';
  await startSandboxFulfillment(jobId, 'What is the best language?', { simulate: 'disagreement' });
  const job = await waitForSettled(jobId);

  assert.equal(job.outcome, 'refunded');
  assert.match(job.refundTx, /^SANDBOX-refund-/);
  assert.ok(job.confidence < 0.6, `expected low confidence, got ${job.confidence}`);
});

test('simulate=no-answers settles as refunded with the no-answers reason', async () => {
  const jobId = 'sandbox-no-answers-1';
  await startSandboxFulfillment(jobId, 'Anyone home?', { simulate: 'no-answers' });
  const job = await waitForSettled(jobId);

  assert.equal(job.outcome, 'refunded');
  assert.equal(job.totalAnswers, 0);
  assert.match(job.reason, /no workers answered/);
});

test('with no ANTHROPIC_API_KEY configured (this test environment), the resolved path stays fully canned/deterministic', async () => {
  // Real success-path coverage (a configured key producing a genuine
  // draftAnswer()) needs live credentials this suite intentionally doesn't
  // have — see reconcile.test.js's draftAnswer test for the same
  // no-key-configured boundary. What's testable and matters here: sandbox
  // mode must never regress to something broken or non-deterministic just
  // because draftAnswer() was wired in as an optional upgrade path.
  const jobId = 'sandbox-no-key-fallback-1';
  await startSandboxFulfillment(jobId, 'No API key in this test env', {});
  const job = await waitForSettled(jobId);

  assert.equal(job.outcome, 'resolved');
  assert.equal(job.reconciliationMethod, 'exact-match-fastpath');
  assert.equal(job.matchingWorkers.length, 3, 'still the canned 3-worker shape, not the llm-draft shape');
});

test('an unrecognized simulate value falls back to the default resolved path rather than erroring', async () => {
  const jobId = 'sandbox-bogus-mode-1';
  await startSandboxFulfillment(jobId, 'Test question', { simulate: 'not-a-real-mode' });
  const job = await waitForSettled(jobId);
  assert.equal(job.outcome, 'resolved');
});

test('a job progresses through awaiting_workers -> reconciling -> settled, matching the real job shape', async () => {
  const jobId = 'sandbox-progression-1';
  await startSandboxFulfillment(jobId, 'Progression test', {});

  const initial = await getJob(jobId);
  assert.equal(initial.status, 'awaiting_workers');

  await waitForSettled(jobId);
  const final = await getJob(jobId);
  assert.equal(final.status, 'settled');
});

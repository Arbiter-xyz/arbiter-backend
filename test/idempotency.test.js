import test from 'node:test';
import assert from 'node:assert/strict';
import { issueChallengeIdempotent } from '../src/oracle.js';
import { claimJob } from '../src/jobs.js';

test('issueChallengeIdempotent with no key mints a fresh questionId every call (current default behavior unchanged)', async () => {
  const a = await issueChallengeIdempotent('question A', 'standard', null, undefined);
  const b = await issueChallengeIdempotent('question A', 'standard', null, undefined);
  assert.notEqual(a.questionId, b.questionId);
});

test('issueChallengeIdempotent with the SAME key returns the exact same challenge on retry, not a new questionId', async () => {
  const key = `idem-${Date.now()}`;
  const first = await issueChallengeIdempotent('what is 2+2', 'standard', null, key);
  const second = await issueChallengeIdempotent('what is 2+2', 'standard', null, key);
  assert.equal(second.questionId, first.questionId);
  assert.deepEqual(second, first);
});

test('issueChallengeIdempotent with DIFFERENT keys mints independent questionIds even for the same question text', async () => {
  const first = await issueChallengeIdempotent('same text', 'standard', null, `key-a-${Date.now()}`);
  const second = await issueChallengeIdempotent('same text', 'standard', null, `key-b-${Date.now()}`);
  assert.notEqual(first.questionId, second.questionId);
});

test('claimJob: only the first caller for a given jobId claims it, every subsequent call for the same id returns false', async () => {
  const jobId = `claim-test-${Date.now()}`;
  assert.equal(await claimJob(jobId), true);
  assert.equal(await claimJob(jobId), false);
  assert.equal(await claimJob(jobId), false);
});

test('claimJob: concurrent (racing) claims for the same id — exactly one wins, matching the fulfillment double-dispatch scenario', async () => {
  const jobId = `claim-race-${Date.now()}`;
  const results = await Promise.all(Array.from({ length: 10 }, () => claimJob(jobId)));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one concurrent claimJob() call must win');
});

test('claimJob: different job ids never contend with each other', async () => {
  const a = `claim-a-${Date.now()}`;
  const b = `claim-b-${Date.now()}`;
  assert.equal(await claimJob(a), true);
  assert.equal(await claimJob(b), true);
});

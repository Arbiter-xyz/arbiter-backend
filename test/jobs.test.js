const test = require('node:test');
const assert = require('node:assert');

const jobs = require('../src/jobs');

test('markPendingReview runs without throwing on a valid jobId', () => {
  assert.doesNotThrow(() => jobs.markPendingReview('some-job-id'));
});

test('markPendingReview accepts extra options without throwing', () => {
  assert.doesNotThrow(() =>
    jobs.markPendingReview('some-job-id', { outcome: 'needs_review' })
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, exactMatchVote } from '../src/vote.js';

test('normalize strips punctuation, collapses whitespace, and preserves Unicode letters/digits', () => {
  assert.equal(normalize('  Yes,   Definitely!! '), 'yes definitely');
  assert.equal(normalize('Café 42 — Résumé'), 'café 42 résumé');
  assert.equal(normalize(null), '');
});

test('exactMatchVote groups normalized answers, preserves first representative, and handles unanimous/split/empty votes', () => {
  assert.deepEqual(exactMatchVote([]), {
    consensus: null,
    confidence: 0,
    matchingWorkerIds: [],
    allAgree: false,
  });

  const unanimous = exactMatchVote([
    { workerId: 'W1', answer: 'Paris!' },
    { workerId: 'W2', answer: '  paris  ' },
    { workerId: 'W3', answer: 'PARIS.' },
  ]);
  assert.deepEqual(unanimous, {
    consensus: 'Paris!',
    confidence: 1,
    matchingWorkerIds: ['W1', 'W2', 'W3'],
    allAgree: true,
  });

  const majority = exactMatchVote([
    { workerId: 'W1', answer: 'No' },
    { workerId: 'W2', answer: 'Yes!' },
    { workerId: 'W3', answer: 'yes' },
  ]);
  assert.deepEqual(majority, {
    consensus: 'Yes!',
    confidence: 2 / 3,
    matchingWorkerIds: ['W2', 'W3'],
    allAgree: false,
  });
});

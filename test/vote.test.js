import test from 'node:test';
import assert from 'node:assert/strict';

import { exactMatchVote, normalize } from '../src/vote.js';

test('normalize trims and lowercases strings', () => {
  assert.equal(normalize('  Hello World  '), 'hello world');
  assert.equal(normalize('MIXED Case'), 'mixed case');
});

test('normalize collapses internal whitespace', () => {
  assert.equal(normalize('a   b\tc\nd'), 'a b c d');
});

test('normalize strips punctuation but keeps letters and digits', () => {
  assert.equal(normalize('The answer is: 42!'), 'the answer is 42');
});

test('exactMatchVote groups equivalent normalized answers', () => {
  const result = exactMatchVote([
    { workerId: 'w1', answer: '  Foo Bar ' },
    { workerId: 'w2', answer: 'foo   bar' },
    { workerId: 'w3', answer: 'something else' },
  ]);
  assert.equal(result.consensus, '  Foo Bar ');
  assert.deepEqual(result.matchingWorkerIds, ['w1', 'w2']);
  assert.equal(result.confidence, 2 / 3);
  assert.equal(result.allAgree, false);
});

test('exactMatchVote reports unanimous agreement', () => {
  const result = exactMatchVote([
    { workerId: 'w1', answer: '42' },
    { workerId: 'w2', answer: '42.' },
  ]);
  assert.equal(result.consensus, '42');
  assert.equal(result.confidence, 1);
  assert.equal(result.allAgree, true);
});

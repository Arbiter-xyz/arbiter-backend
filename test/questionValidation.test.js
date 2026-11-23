import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion } from '../src/questionValidation.js';
import { config } from '../src/config.js';

// Issue #562: the single question check shared by POST /oracle/sandbox and
// every question-creating branch of POST /oracle.
test('validateQuestion accepts a non-empty string within the limit', () => {
  assert.equal(validateQuestion('Is it raining in Lagos?'), null);
  assert.equal(validateQuestion('x'.repeat(config.maxQuestionLength)), null);
});

test('validateQuestion requires a non-empty string', () => {
  for (const bad of [undefined, null, '', 0, 42, true, {}, ['q']]) {
    assert.equal(validateQuestion(bad), 'body.question (string) is required');
  }
});

test('validateQuestion rejects a question longer than config.maxQuestionLength', () => {
  assert.equal(
    validateQuestion('x'.repeat(config.maxQuestionLength + 1)),
    `body.question must be at most ${config.maxQuestionLength} characters`,
  );
});

test('validateQuestion honors an explicit maxLength', () => {
  assert.equal(validateQuestion('abc', 3), null);
  assert.equal(validateQuestion('abcd', 3), 'body.question must be at most 3 characters');
});

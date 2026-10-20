'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { exactMatchVote, normalize } = require('../src/vote');

test('normalize trims and lowercases strings', () => {
  assert.strictEqual(normalize('  Hello World  '), 'hello world');
  assert.strictEqual(normalize('MIXED Case'), 'mixed case');
});

test('normalize collapses internal whitespace', () => {
  assert.strictEqual(normalize('a   b\tc\nd'), 'a b c d');
});

test('normalize handles non-string input', () => {
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
  assert.strictEqual(normalize(42), '42');
});

test('exactMatchVote returns true for equivalent normalized values', () => {
  assert.strictEqual(exactMatchVote('  Foo Bar ', 'foo   bar'), true);
});

test('exactMatchVote returns false for differing values', () => {
  assert.strictEqual(exactMatchVote('foo', 'bar'), false);
});

test('exactMatchVote treats empty/missing values consistently', () => {
  assert.strictEqual(exactMatchVote(null, undefined), true);
  assert.strictEqual(exactMatchVote('', null), true);
  assert.strictEqual(exactMatchVote('x', null), false);
});

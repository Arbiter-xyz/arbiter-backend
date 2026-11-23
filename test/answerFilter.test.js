import test from 'node:test';
import assert from 'node:assert/strict';

import { screenAnswer } from '../src/answerFilter.js';

const baseOpts = () => ({
  enabled: true,
  blocklist: ['scam', 'rug pull'],
  maxLinks: 2,
  maxRepeatedChars: 5,
  minLettersForCaseCheck: 20,
  maxUppercaseRatio: 0.5,
});

test('screenAnswer returns ok when filter is disabled', () => {
  assert.deepEqual(screenAnswer('anything goes', { enabled: false }), { ok: true });
  assert.deepEqual(screenAnswer('anything goes', undefined), { ok: true });
});

test('screenAnswer rejects non-string answers', () => {
  const result = screenAnswer(42, baseOpts());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'answer must be a string');
});

test('screenAnswer matches blocklisted words on word boundaries', () => {
  const opts = baseOpts();
  assert.equal(screenAnswer('this is a scam', opts).ok, false);
  assert.equal(screenAnswer('that was a rug pull', opts).ok, false);
  // Substring inside another word should not match.
  assert.equal(screenAnswer('scampi and scallops', opts).ok, true);
});

test('screenAnswer matches blocklist after NFKC normalisation', () => {
  const opts = baseOpts();
  // Fullwidth characters normalise to ASCII under NFKC.
  const fullwidth = '\uFF53\uFF43\uFF41\uFF4D'; // "scam"
  assert.equal(screenAnswer(`this is ${fullwidth}`, opts).ok, false);
});

test('screenAnswer rejects answers with too many links', () => {
  const opts = baseOpts();
  const tooMany = 'see https://a.example https://b.example https://c.example';
  const result = screenAnswer(tooMany, opts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'answer contains too many links');

  const withinLimit = 'see https://a.example https://b.example';
  assert.equal(screenAnswer(withinLimit, opts).ok, true);
});

test('screenAnswer rejects long repeated-character runs', () => {
  const opts = baseOpts();
  const result = screenAnswer('sooooooo good', opts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'answer contains excessive repeated characters');

  assert.equal(screenAnswer('sooo good', opts).ok, true);
});

test('screenAnswer only applies uppercase ratio above minLettersForCaseCheck', () => {
  const opts = baseOpts();
  // Short all-caps answer is below the letter threshold and allowed.
  assert.equal(screenAnswer('OK', opts).ok, true);

  // Long mostly-uppercase answer exceeds the ratio and is rejected.
  const shouty = 'THIS IS A VERY LOUD ANSWER WITH MANY LETTERS';
  const result = screenAnswer(shouty, opts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'answer has excessive uppercase');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { answerChannel } from '../src/dispatch.js';
import { config } from '../src/config.js';

// Issue #560: one channel-name function for cross-instance answer routing,
// built from config.quorum.channelPrefix, so every publisher and subscriber
// agrees on the channel for a question.
test('answerChannel prefixes the question id with config.quorum.channelPrefix', () => {
  assert.equal(answerChannel('q-1'), `${config.quorum.channelPrefix}q-1`);
});

test('answerChannel defaults to the documented quorum:answers: prefix', () => {
  if (process.env.QUORUM_CHANNEL_PREFIX) return;
  assert.equal(answerChannel('q-1'), 'quorum:answers:q-1');
});

test('answerChannel gives the same name for numeric, BigInt and string question ids', () => {
  assert.equal(answerChannel(42), answerChannel('42'));
  assert.equal(answerChannel(42n), answerChannel('42'));
});

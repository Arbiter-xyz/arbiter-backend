const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const mockCreate = async () => {
  throw new Error('client.messages.create not mocked');
};

require.cache[require.resolve('@anthropic-ai/sdk')] = {
  id: require.resolve('@anthropic-ai/sdk'),
  filename: require.resolve('@anthropic-ai/sdk'),
  loaded: true,
  exports: function Anthropic() {
    return { messages: { create: (...args) => mockCreate(...args) } };
  },
};

const { reconcileWithClaude, exactMatchVote } = require('../src/reconcile');

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
});

function toolResponse(input) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'report_consensus',
        input,
      },
    ],
  };
}

const splitSubmissions = [
  { workerId: 'w1', answer: 'Paris' },
  { workerId: 'w2', answer: 'Lyon' },
];

test('exactMatchVote credits the majority answer', () => {
  const result = exactMatchVote([
    { workerId: 'a', answer: 'yes' },
    { workerId: 'b', answer: 'YES' },
    { workerId: 'c', answer: 'no' },
  ]);
  assert.deepStrictEqual(result.matching_worker_ids.sort(), ['a', 'b']);
  assert.strictEqual(result.confidence, 2 / 3);
});

test('reconcileWithClaude returns empty result for no submissions', async () => {
  const result = await reconcileWithClaude([]);
  assert.deepStrictEqual(result, {
    consensus: null,
    confidence: 0,
    matching_worker_ids: [],
  });
});

test('reconcileWithClaude uses fast path when everyone agrees', async () => {
  const result = await reconcileWithClaude([
    { workerId: 'a', answer: 'yes' },
    { workerId: 'b', answer: 'yes' },
  ]);
  assert.deepStrictEqual(result.matching_worker_ids.sort(), ['a', 'b']);
  assert.strictEqual(result.confidence, 1);
});

test('reconcileWithClaude falls back when no API key is set', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const result = await reconcileWithClaude(splitSubmissions);
  assert.strictEqual(result.confidence, 0.5);
});

test('reconcileWithClaude returns model result when ids are all known', async () => {
  mockCreate = async () =>
    toolResponse({
      consensus: 'Paris',
      confidence: 0.5,
      matching_worker_ids: ['w1'],
    });
  const result = await reconcileWithClaude(splitSubmissions);
  assert.deepStrictEqual(result.matching_worker_ids, ['w1']);
  assert.strictEqual(result.consensus, 'Paris');
});

test('reconcileWithClaude never returns an unknown worker id from the model', async () => {
  mockCreate = async () =>
    toolResponse({
      consensus: 'Paris',
      confidence: 0.9,
      matching_worker_ids: ['w1', 'ghost-worker'],
    });

  const result = await reconcileWithClaude(splitSubmissions);

  const knownIds = new Set(splitSubmissions.map((s) => s.workerId));
  for (const id of result.matching_worker_ids) {
    assert.ok(
      knownIds.has(id),
      `unknown worker id ${id} leaked to caller`
    );
  }
  assert.ok(!result.matching_worker_ids.includes('ghost-worker'));
});

test('reconcileWithClaude falls back when model returns only unknown ids', async () => {
  mockCreate = async () =>
    toolResponse({
      consensus: 'Paris',
      confidence: 0.9,
      matching_worker_ids: ['ghost-worker'],
    });

  const result = await reconcileWithClaude(splitSubmissions);

  const knownIds = new Set(splitSubmissions.map((s) => s.workerId));
  for (const id of result.matching_worker_ids) {
    assert.ok(knownIds.has(id), `unknown worker id ${id} leaked to caller`);
  }
});

test('reconcileWithClaude falls back when model returns non-array ids', async () => {
  mockCreate = async () =>
    toolResponse({
      consensus: 'Paris',
      confidence: 0.9,
      matching_worker_ids: 'w1',
    });
  const result = await reconcileWithClaude(splitSubmissions);
  assert.strictEqual(result.confidence, 0.5);
});

test('reconcileWithClaude falls back when model call throws', async () => {
  mockCreate = async () => {
    throw new Error('boom');
  };
  const result = await reconcileWithClaude(splitSubmissions);
  assert.strictEqual(result.confidence, 0.5);
});
